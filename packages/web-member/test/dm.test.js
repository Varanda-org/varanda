'use strict'

// Direct messages in the browser node (lib/dm.js through lib/session.js and
// lib/node.js, an in-memory client), against the loopback seeder stand-in of
// helpers/dm-seeder.js. Catch-up tests use a real seeder on a local DHT so
// they can verify freshness against another device's longer diary.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { WebSocket } = require('ws')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const dmCore = require('@varanda/core/lib/dm')
const { verifyDmReport } = require('@varanda/core/lib/report')
const { createBrowserNode } = require('../lib/node')
const { createDmEngine, voiceMs } = require('../lib/dm')
const { createDmStore } = require('../lib/dm-store')
const member = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('../lib/passkey')
const gc = require('@varanda/core/lib/group-crypto')
const store = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')
const { dmSeeder, rsaKey } = require('./helpers/dm-seeder')
const postage = require('@varanda/core/lib/dm-postage')
const { testnet } = require('./helpers/net')
const { seederOverWs, once } = require('./helpers/sync-groups')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const SECRET = 'mensagem-secreta-zqx'
const GATE_LINE = 'sincronizando antes de publicar'

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function until (fn, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('tempo esgotado')
}

// Opens a sealed kv value (a wallet stamp, a queue item) with the local key
// of `prf`, as the engine does while unlocked.
async function opener (prf) {
  const key = await dmLocalKeyFromPrf(prf)
  return { open: (b) => gc.openRecord({ nonce: b.nonce, box: b.box }, key), seal: (v) => gc.sealRecord(v, key) }
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// A member node: identity created and certified, dm keys from `prf`.
async function memberNode (t, assoc, url, { keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), enable = true, certify = true, walletAt = dmCore.DM_STAMP_WALLET, dm = {}, options = {} } = {}) {
  const storage = memoryNodeStorage()
  const node = createBrowserNode({
    storage,
    association: hex(assoc.publicKey),
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { dm: { issuePaceMs: 0, ...dm } },
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  let enabled = null
  if (enable) {
    enabled = await web.request('dm.enable')
    await until(async () => (await wallet(storage)) >= walletAt)
  }
  return { node, web, storage, key: publicKey, keyPair, prf, enabled }
}

// Copies `from`'s diary into `to`'s storage as a stored replica (what a
// follow would have downloaded), in process.
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

async function rawLocal (storage) {
  if (!(await storage.hasCore(store.DM_LOCAL))) return ''
  const core = new Hypercore(storage.core(store.DM_LOCAL), { valueEncoding: 'binary' })
  await core.ready()
  const out = []
  for (let i = 0; i < core.length; i++) out.push(b4a.toString(await core.get(i), 'utf8'))
  await core.close()
  return out.join('\n')
}

async function kvDump (storage) {
  const out = []
  for (const k of ['dmKey', 'dmCursor', 'dmSeen', 'dmStamps', 'follows']) out.push(JSON.stringify(await storage.readJson(k)))
  return out.join('\n')
}

test('request, accept, block, second device, ctl privacy, no plaintext at rest', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })

  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  const boxA = await dmBoxKeyPairFromPrf(A.prf, 1)
  t.alike(A.enabled, { box: hex(boxA.publicKey), gen: 1, seq: 1 }, 'dm.enable publishes the box derived at unlock')
  t.alike(await A.web.request('dm.enable'), { box: hex(boxA.publicKey), gen: 1, seq: null }, 'a second enable appends nothing')

  await copyDiary(A, B)
  t.alike(await B.web.request('dm.lookup', { member: A.key }), { box: hex(boxA.publicKey), gen: 1 })

  t.is((await errorOf(B.web.request('dm.send', { to: B.key, text: 'eu' }))).message, 'não é possível enviar para si')
  const sent = await B.web.request('dm.send', { to: A.key, text: SECRET })
  t.ok(/^[0-9a-f]{32}$/.test(sent.id))
  t.is(seeder.puts.length, 2, 'recipient drop and self copy')

  const pulled = await A.web.request('dm.pull')
  t.is(pulled.added, 1)
  t.is(pulled.incomplete, false)
  t.ok(A.web.events.some((e) => e.name === 'dm.changed' && e.data.added === 1))
  let inbox = await A.web.request('dm.list', {})
  t.is(inbox.conversations.length, 0, 'A follows nobody: not in the inbox')
  t.is(inbox.requests, true)
  const req = await A.web.request('dm.list', { folder: 'request' })
  t.is(req.conversations.length, 1)
  t.is(req.conversations[0].peer, B.key)
  t.is(req.conversations[0].preview, SECRET)
  t.is(req.conversations[0].mine, false)
  t.is((await A.web.request('dm.pull')).added, 0, 'a repeated pull adds nothing')

  const thread = await A.web.request('dm.thread', { peer: B.key })
  t.is(thread.messages.length, 1)
  t.is(thread.messages[0].text, SECRET)
  t.is(thread.next, null)
  await A.web.request('dm.seen', { peer: B.key })
  t.is((await A.web.request('dm.list', { folder: 'request' })).conversations[0].unread, false)

  const before = seeder.puts.length
  await A.web.request('dm.set', { peer: B.key, state: 'accepted' })
  inbox = await A.web.request('dm.list', {})
  t.is(inbox.conversations.length, 1, 'accepted moves it to the inbox')
  t.is(inbox.conversations[0].peer, B.key)

  await A.web.request('dm.set', { peer: B.key, state: 'blocked' })
  await A.web.request('dm.set', { peer: B.key, state: 'declined' })
  await A.web.request('dm.set', { peer: B.key, state: 'deleted' })
  // Every ctl went to A's own box only: B's box opens none of them.
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  const ctlPuts = seeder.puts.slice(before)
  t.is(ctlPuts.length, 4)
  for (const bytes of ctlPuts) {
    const drop = dmCore.decodeDrop(bytes)
    t.is(dmCore.openSealed(drop.sealed, boxB), null, 'the peer cannot open a ctl')
    const inner = dmCore.openSealed(drop.sealed, boxA)
    const body = dmCore.openInner(inner, A.key)
    t.is(body.kind, 'ctl')
    t.is(body.to, A.key, 'sealed from and to the own key')
  }

  await B.web.request('dm.send', { to: A.key, text: 'de novo' })
  t.is((await A.web.request('dm.pull')).added, 0, 'blocked: the next pull files nothing')
  t.is((await errorOf(A.web.request('dm.send', { to: B.key, text: 'oi' }))).message, 'você bloqueou esta pessoa')

  // B's second device: same passkey, fresh storage.
  const B2 = await memberNode(t, assoc, seeder.url, { keyPair: B.keyPair, prf: B.prf, enable: false })
  t.is((await B2.web.request('dm.pull')).added, 2, 'both sent copies arrive')
  const t2 = await B2.web.request('dm.thread', { peer: A.key })
  t.alike(t2.messages.map((m) => [m.text, m.mine]), [[SECRET, true], ['de novo', true]])
  await B.web.request('dm.set', { peer: A.key, state: 'deleted' })
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0, "B's delete ctl reaches the other device")

  // Nothing on the anonymous channel names a diary.
  for (const bytes of seeder.puts) {
    for (const k of [A.key, B.key]) t.is(b4a.indexOf(bytes, b4a.from(k, 'hex')), -1)
  }
  for (const text of seeder.traffic) {
    t.absent(text.includes(A.key) || text.includes(B.key), 'no hex diary key on the dm channel')
  }

  // At rest: ciphertext only.
  for (const n of [A, B, B2]) {
    const raw = (await rawLocal(n.storage)) + (await kvDump(n.storage))
    t.absent(raw.includes(SECRET), 'no message text at rest')
    t.absent(raw.includes(n === A ? B.key : A.key), 'no peer key at rest')
  }
  t.ok(await A.storage.hasCore(store.DM_LOCAL))
  t.absent((await kvDump(A.storage)).includes(store.DM_LOCAL), 'the local store is in no kv list the sync reads')

  // Reports carry the sender key as target.
  const nonce = 'a'.repeat(43)
  const { signature } = await A.web.request('dm.reportSign', { nonce, target: B.key, reason: 'spam', quote: SECRET })
  t.alike(verifyDmReport({ nonce, member: A.key, association: hex(assoc.publicKey), target: B.key, reason: 'spam', text: '', quote: SECRET }, signature), { ok: true })
  t.is((await errorOf(A.web.request('dm.reportSign', { nonce, target: A.key, reason: 'spam', quote: 'x' }))).message, 'não é possível denunciar a própria chave')

  // Lock: nothing readable.
  await A.node.clearKeyPair()
  for (const [m, p] of [['dm.pull', {}], ['dm.list', {}], ['dm.thread', { peer: B.key }]]) {
    const err = await errorOf(A.web.request(m, p))
    t.is(err && err.message, LOCKED, m + ' refused while locked')
  }
})

test('an uncertain send is not put again until the user retries, then the same bytes', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  let cut = false
  const seeder = await dmSeeder(t, { signer: assoc, dropPutAck: (n) => cut && n === seeder.puts.length - 1 && !(cut = false) })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, C)
  cut = true
  const err = await errorOf(C.web.request('dm.send', { to: A.key, text: 'talvez' }))
  t.is(err && err.message, 'não deu para confirmar o envio')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(seeder.puts.length, 1, 'never put again by the node')
  const ok = await C.web.request('dm.send', { to: A.key, text: 'talvez' })
  t.ok(/^[0-9a-f]{32}$/.test(ok.id))
  t.is(seeder.puts.length, 3)
  t.ok(b4a.equals(seeder.puts[0], seeder.puts[1]), 'the retry re-puts the same drop')
  t.is(seeder.pool.entries.length, 2, 'one message: two drops in the pool')
  t.is((await A.web.request('dm.pull')).added, 1)
  t.is((await C.web.request('dm.thread', { peer: A.key })).messages.length, 1)
})

test('a failed pull can be called again; one pull at a time', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const [p1, p2] = await Promise.all([errorOf(A.web.request('dm.pull')), errorOf(A.web.request('dm.pull'))])
  t.ok(p1 === null || p2 === null, 'one pull ran')
  t.ok([p1, p2].some((e) => e === null || e.message === 'mensagens já em andamento'))
  await seeder.close()
  const e1 = await errorOf(A.web.request('dm.pull'))
  t.is(e1 && e1.message, 'sem conexão com o semeador')
  const e2 = await errorOf(A.web.request('dm.pull'))
  t.is(e2 && e2.message, 'sem conexão com o semeador', 'callable again after an error')
})

// The own newest dm-key's seq and the diary length, read from the storage.
async function ownDmKey (n) {
  const diary = await store.openDiary(n.storage)
  try {
    const entries = await store.readAll(diary)
    return { seq: member.newestDmKey(entries).seq, length: diary.length }
  } finally {
    await diary.close()
  }
}

async function posts (n, count) {
  for (let i = 0; i < count; i++) await n.web.request('post.create', { text: 'p' + i })
}

test('dm.enable skips the write gate for a current key and refuses an empty diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = generateAssociationKeyPair()
  const seeder = await seederOverWs(t, assoc, bootstrap)
  const A = await memberNode(t, assoc, seeder.url, { enable: false, certify: false, options: { writeGate: true } })
  const err = await errorOf(A.web.request('dm.enable'))
  t.is(err && err.message, member.GENESIS_REQUIRED, 'an empty diary still needs its certificate')
  t.is(await store.readDmKey(A.storage), null, 'the refusal does not enable messages locally')
  await A.web.request('cert.add', { cert: createCert({ member: A.key }, assoc) })
  const first = await A.web.request('dm.enable')
  t.ok(first.seq !== null, 'a missing key is appended through the gate')
  t.ok(A.web.events.some((e) => e.name === 'sync.event' && e.data.line === GATE_LINE), 'the gate ran for writes')

  await A.storage.writeJson('dmKey', null)
  const from = A.web.events.length
  t.alike(await A.web.request('dm.enable'), { ...first, seq: null }, 'a current key appends nothing')
  t.alike(await store.readDmKey(A.storage), { v: 1, gen: first.gen }, 'the shortcut restores the local marker')
  t.absent(A.web.events.slice(from).some((e) => e.name === 'sync.event' && e.data.line === GATE_LINE), 'no write-gate line for a current key')
  t.absent(A.web.events.slice(from).some((e) => e.name === 'sync.started'), 'no gate or push run')

  const { runId } = await A.web.request('sync.start', {})
  await until(() => A.web.events.some((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line.startsWith('diário próprio sincronizado')))
  await A.web.request('dm.list', {})
  t.alike(await A.web.request('sync.status'), { state: 'running', runId, once: false }, 'a current key rechecked after catch-up keeps the live run')
  t.absent(A.web.events.slice(from).some((e) => e.name === 'sync.stopped' && e.data.reason === 'preempted'), 'the recheck reads the live cores')
  await A.web.request('sync.stop')
})

test('a current dm-key checked before catch-up is refreshed once after the diary catches up', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = generateAssociationKeyPair()
  const seeder = await seederOverWs(t, assoc, bootstrap)
  const A = await memberNode(t, assoc, seeder.url, { enable: false, options: { writeGate: true } })
  const first = await A.web.request('dm.enable')
  t.is((await A.web.request('dm.enable')).seq, null, 'current with no continuous run')

  // A sibling extends the same diary while this device keeps its old tip.
  const storage = memoryNodeStorage()
  const ctx = { storage, association: hex(assoc.publicKey), keyPair: A.keyPair }
  await member.idCreate(ctx)
  const src = await store.openDiary(A.storage)
  const dst = await store.openDiary(storage)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
  for (let i = 0; i <= member.DM_KEY_REFRESH_BLOCKS; i++) await member.postCreate(ctx, { text: 'p' + i })
  const pushed = await once({ storage }, seeder.url, [])
  t.is(pushed.seederConfirmed, true, 'the seeder holds the longer diary')
  const before = await ownDmKey(A)
  t.is(before.seq, first.seq)
  t.is(before.length, first.seq + 1, 'this device still has the short diary')

  const from = A.web.events.length
  const { runId } = await A.web.request('sync.start', {})
  await until(() => A.web.events.some((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line === 'diário próprio sincronizado (' + (before.length + member.DM_KEY_REFRESH_BLOCKS + 1) + ')'))
  const refreshed = () => A.web.events.slice(from).some((e) => e.name === 'sync.stopped' && e.data.runId === runId && e.data.reason === 'preempted')
  await until(refreshed)
  await A.web.request('sync.stop')
  const after = await ownDmKey(A)
  t.is(after.seq, before.length + member.DM_KEY_REFRESH_BLOCKS + 1, 'catch-up appended the key after the sibling posts')
  t.is(after.length, after.seq + 1, 'exactly one refresh was appended')
  t.absent(A.web.events.slice(from).some((e) => e.name === 'sync.event' && e.data.line === GATE_LINE), 'the caught-up continuous run satisfies the gate')

  const next = await A.web.request('sync.start', {})
  await until(() => A.web.events.some((e) => e.name === 'sync.event' && e.data.runId === next.runId && e.data.line.startsWith('diário próprio sincronizado')))
  await A.web.request('dm.list', {})
  t.alike(await A.web.request('sync.status'), { state: 'running', runId: next.runId, once: false }, 'the next catch-up keeps the current key and live run')
  await A.web.request('sync.stop')
  t.alike(await ownDmKey(A), after, 'no second refresh')
})

test('the own dm-key is refreshed once it leaves the newest 256 blocks (enable and unlock)', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  await posts(A, member.DM_KEY_REFRESH_BLOCKS + 1)
  const r = await A.web.request('dm.enable')
  t.is(r.gen, 1)
  t.ok(r.seq !== null, 'dm.enable re-appends the same key')
  t.is(r.box, A.enabled.box)
  t.is((await A.web.request('dm.enable')).seq, null, 'then nothing')

  await posts(A, member.DM_KEY_REFRESH_BLOCKS + 1)
  const stale = await ownDmKey(A)
  t.ok(stale.seq < stale.length - member.DM_KEY_REFRESH_BLOCKS)
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(async () => {
    const k = await ownDmKey(A)
    return k.seq >= k.length - member.DM_KEY_REFRESH_BLOCKS
  })
  t.pass('the unlock refreshed it')
})

test('a replica without a dm-key in what it read falls back to the peek, never answers none', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url, { enable: false })
  const B = await memberNode(t, assoc, seeder.url, { options: { peekTimeoutMs: 300 } })
  await copyDiary(A, B)
  await A.web.request('dm.enable')
  const err = await errorOf(B.web.request('dm.lookup', { member: A.key }))
  t.is(err && err.message, 'semeador indisponível', 'the lookup went to the peek path')
})

test('dm.set with an empty wallet queues the sealed ctl; a top-up does not put it, the next dm.set does', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc, budget: 1 })
  const A = await memberNode(t, assoc, seeder.url, { walletAt: 1, dm: { topUpEveryMs: 0, topUpRetryMs: 0 } })
  const peer = 'ef'.repeat(32)
  await A.web.request('dm.set', { peer, state: 'accepted' })
  t.is(seeder.puts.length, 1)
  await A.web.request('dm.set', { peer, state: 'blocked' })
  t.is(seeder.puts.length, 1, 'no stamp: nothing put')
  const queued = await A.storage.readJson('dmCtlQueue')
  t.is(queued.items.length, 1)
  t.absent(JSON.stringify(queued).includes(peer), 'the queue holds ciphertext only')
  seeder.budget = 1000
  await A.web.request('dm.enable')
  await until(async () => (await wallet(A.storage)) >= dmCore.DM_STAMP_WALLET_LOW)
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(seeder.puts.length, 1, 'a top-up puts nothing')
  t.is((await A.storage.readJson('dmCtlQueue')).items.length, 1)
  await A.web.request('dm.set', { peer, state: 'unblocked' })
  t.is(seeder.puts.length, 3, 'the next dm.set puts the queued ctl, then its own')
  t.is((await A.storage.readJson('dmCtlQueue')).items.length, 0)
  const boxA = await dmBoxKeyPairFromPrf(A.prf, 1)
  const ops = seeder.puts.slice(1).map((d) => dmCore.openInner(dmCore.openSealed(dmCore.decodeDrop(d).sealed, boxA), A.key))
  t.alike(ops.map((b) => [b.kind, b.op]), [['ctl', 'blocked'], ['ctl', 'unblocked']], 'in filing order')
})

test('a lost-ack ctl put again lands once in the pool and spends one stamp', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  let cuts = 0
  const seeder = await dmSeeder(t, { signer: assoc, dropPutAck: () => cuts > 0 && cuts-- > 0 })
  const A = await memberNode(t, assoc, seeder.url)
  const peer = 'ef'.repeat(32)
  const queue = async () => ((await A.storage.readJson('dmCtlQueue')) || { items: [] }).items
  const before = await wallet(A.storage)
  const pooled = seeder.pool.entries.length
  const local = await opener(A.prf)

  cuts = 2
  await A.web.request('dm.set', { peer, state: 'accepted' })
  const [sealedItem] = await queue()
  const raw = JSON.stringify(sealedItem)
  t.absent(raw.includes(b4a.toString(seeder.puts[0], 'base64').slice(0, 64)), 'the queued drop is ciphertext at rest')
  const queued = local.open(sealedItem).b
  t.is(b4a.from(queued, 'base64').byteLength, dmCore.DM_DROP_BYTES, 'the queue holds the stamped drop')
  t.ok(b4a.equals(b4a.from(queued, 'base64'), seeder.puts[0]), 'the exact bytes that were put')
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(() => seeder.puts.length === 2)
  t.is((await queue()).length, 1, 'still unacked: kept')
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(async () => (await queue()).length === 0)
  t.is(seeder.puts.length, 3)
  t.ok(b4a.equals(seeder.puts[0], seeder.puts[1]) && b4a.equals(seeder.puts[1], seeder.puts[2]), 'every put is byte-identical')
  t.is(seeder.pool.entries.length, pooled + 1, 'one drop in the pool')
  t.is(await wallet(A.storage), before - 1, 'one stamp spent')
})

test('stamps are sealed at rest: no token or sig in kv; locked spends nothing, unlock spends again', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const peer = 'ef'.repeat(32)
  const local = await opener(A.prf)
  const kv = await A.storage.readJson('dmStamps')
  t.is(kv.v, 2)
  t.ok(kv.items.length >= dmCore.DM_STAMP_WALLET_LOW)
  const plain = kv.items.map((s) => local.open(s))
  t.ok(plain.every((p) => p !== null && /^[0-9a-f]{64}$/.test(p.token)), 'each item opens under the local key')
  for (const p of plain) {
    t.absent(JSON.stringify(kv).includes(p.token), 'no token in clear')
    t.absent(JSON.stringify(kv).includes(p.sig.slice(0, 40)), 'no sig in clear')
  }
  t.ok(kv.items.every((s) => Object.keys(s).sort().join() === 'box,kid,nonce'), 'only kid, nonce and box')

  await A.node.clearKeyPair()
  t.alike(await A.storage.readJson('dmStamps'), kv, 'locking leaves the sealed wallet as it was')
  const puts = seeder.puts.length
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await A.web.request('dm.set', { peer, state: 'accepted' })
  t.is(seeder.puts.length, puts + 1, 'after unlock a stamp is spent again')

  // A plaintext wallet of the earlier form is dropped, never spent.
  await A.storage.writeJson('dmStamps', { v: 1, items: plain.map((p, i) => ({ kid: kv.items[i].kid, token: p.token, sig: p.sig })), kids: kv.kids })
  await A.web.request('dm.set', { peer, state: 'declined' })
  t.is(seeder.puts.length, puts + 1, 'the v1 plaintext stamps are not used')
  t.is((await A.storage.readJson('dmCtlQueue')).items.length, 1, 'the ctl waits, sealed')
})

test('dm.thread: a peer reusing the cursor id cannot pull "load older" back', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const { engine, storage } = engineFor(t, seeder)
  const kp = crypto.keyPair()
  const own = hex(kp.publicKey)
  await certify(storage, kp, assoc)
  const prf = crypto.randomBytes(32)
  await engine.unlock(prf)
  t.ok((await engine.topUp(kp, { force: true })) > 0)
  const box = await dmBoxKeyPairFromPrf(prf, 1)
  // um, dois (peer), três (own, id X), quatro (own), then the peer's cinco
  // reusing X: the newest row with X is the peer's.
  const peer = crypto.keyPair()
  const peerHex = hex(peer.publicKey)
  const certs = { [peerHex]: createCert({ member: peerHex }, assoc), [own]: createCert({ member: own }, assoc) }
  const { openDmLink } = require('../lib/dm-link')
  const link = await openDmLink({ seederUrl: seeder.url, createSocket: (u) => { const ws = new WebSocket(u); ws.on('error', noop); return ws }, association: seeder.assoc })
  const stampsKv = await storage.readJson('dmStamps')
  const local = await opener(prf)
  let k = 0
  async function put (signer, fields) {
    const from = hex(signer.publicKey)
    const inner = dmCore.buildInner({ kind: 'msg', to: from === own ? peerHex : own, cert: certs[from], ...fields }, signer)
    const item = stampsKv.items[k++]
    const s = local.open(item)
    const drop = dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: b4a.from(item.kid, 'hex'), rsaSig: b4a.from(s.sig, 'base64'), token: b4a.from(s.token, 'hex'), sealed: dmCore.sealInner(inner, hex(box.publicKey)) })
    t.alike(await link.put(drop), { ok: true, reason: null })
  }
  const X = dmCore.newMessageId()
  const at = (i) => new Date(Date.now() - (10 - i) * 60000).toISOString()
  await put(peer, { text: 'um', at: at(0) })
  await put(peer, { text: 'dois', at: at(1) })
  await put(kp, { id: X, text: 'três', at: at(2) })
  await put(kp, { text: 'quatro', at: at(3) })
  // The peer reuses X twice: once newer, once backdated to sort first. Both
  // copies are filed after the own message, so the thread keeps only 'três'.
  await put(peer, { id: X, text: 'cinco', at: at(4) })
  await put(peer, { id: X, text: 'antigo', at: '2000-01-01T00:00:00.000Z' })
  link.close()
  t.ok((await engine.pull(own)).added >= 4)
  const first = await engine.thread(own, { peer: peerHex, limit: 3 })
  t.alike(first.messages.map((m) => m.text), ['dois', 'três', 'quatro'], 'neither reused copy is in the thread')
  const older = await engine.thread(own, { peer: peerHex, before: first.next, limit: 3 })
  t.alike(older.messages.map((m) => m.text), ['um'], 'paging reaches the oldest message')
  t.is(older.next, null)
  const fromX = await engine.thread(own, { peer: peerHex, before: X, limit: 3 })
  t.alike(fromX.messages.map((m) => m.text), ['um', 'dois'], 'a cursor at X pages from the own message')
})

test('a pull drops a sender on the stored association blocklist', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await B.web.request('dm.send', { to: A.key, text: 'antes' })
  t.is((await A.web.request('dm.pull')).added, 1)
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, assoc)
  await store.writeBlocklist(A.storage, createSnapshot({ seq: 1, blocked: [B.key] }, mod, modCert))
  await B.web.request('dm.send', { to: A.key, text: 'depois' })
  t.is((await A.web.request('dm.pull')).added, 0, 'blocked by the association: nothing filed')
})

test('a top-up under an announced key that yields no stamp keeps the unspent wallet', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const { engine, storage } = engineFor(t, seeder)
  const kp = crypto.keyPair()
  await certify(storage, kp, assoc)
  await engine.unlock(crypto.randomBytes(32))
  t.ok((await engine.topUp(kp, { force: true })) > 0)
  const before = await storage.readJson('dmStamps')
  // Two keys in a row announced and no stamp issued under either: a real
  // rotation shows itself by a stamp that verifies, so nothing is dropped.
  seeder.budget = 0
  for (const bump of [2n, 4n]) {
    // A different modulus: only announced, never used to sign.
    seeder.announce = postage.publicKey(rsaKey().n + bump)
    t.is(await engine.topUp(kp, { force: true }), 0)
  }
  const after = await storage.readJson('dmStamps')
  t.is(after.items.length, before.items.length, 'no unspent stamp dropped')
  t.alike(after.kids, before.kids, 'the kids did not rotate')
})

function engineFor (t, seeder, { createStore, createSocket, limits = {} } = {}) {
  const sockets = []
  const storage = memoryNodeStorage()
  const engine = createDmEngine({
    storage,
    association: seeder.assoc,
    seederUrl: seeder.url,
    createSocket: createSocket || ((u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      sockets.push(ws)
      return ws
    }),
    limits: { issuePaceMs: 0, ...limits },
    ...(createStore ? { createStore } : {})
  })
  t.teardown(() => engine.close(), { force: true })
  return { engine, sockets, storage }
}

// Writes block 0 (the member certificate) into an engine's storage, as
// cert.add would: the engine reads its own cert from there.
async function certify (storage, kp, assoc) {
  const diary = await store.openDiary(storage, kp)
  await store.appendRecord(diary, { type: 'member-cert', cert: createCert({ member: hex(kp.publicKey) }, assoc) })
  await diary.close()
}

// Restore the cache immediately so other engines keep the real transport.
function engineWithDmLink (link) {
  const transport = require('../lib/dm-link')
  const original = transport.openDmLink
  const id = require.resolve('../lib/dm')
  const cached = require.cache[id]
  try {
    transport.openDmLink = async () => link
    delete require.cache[id]
    return require('../lib/dm').createDmEngine
  } finally {
    transport.openDmLink = original
    require.cache[id] = cached
  }
}

async function sendingEngine (t, { stamps = 2, failPut = false } = {}) {
  const calls = []
  const link = {
    failPut,
    async put () {
      calls.push(['put'])
      if (link.failPut) throw new Error('lost ack')
      return { ok: true, reason: null }
    },
    close: noop
  }
  const storage = memoryNodeStorage()
  const assoc = generateAssociationKeyPair()
  const kp = crypto.keyPair()
  const own = hex(kp.publicKey)
  const peer = hex(crypto.keyPair().publicKey)
  const prf = crypto.randomBytes(32)
  const engine = engineWithDmLink(link)({
    storage,
    association: hex(assoc.publicKey),
    emit: (name, data) => calls.push([name, data])
  })
  t.teardown(() => engine.close(), { force: true })
  await certify(storage, kp, assoc)
  await engine.unlock(prf)
  const local = await opener(prf)
  const kid = 'ab'.repeat(8)
  await store.writeDmStamps(storage, {
    kids: [kid],
    items: Array.from({ length: stamps }, () => ({
      kid,
      ...local.seal({ token: hex(crypto.randomBytes(32)), sig: b4a.toString(b4a.alloc(dmCore.DROP.SIG_BYTES), 'base64') })
    }))
  })
  const recipientBox = hex((await dmBoxKeyPairFromPrf(crypto.randomBytes(32), 1)).publicKey)
  return {
    engine,
    storage,
    prf,
    calls,
    link,
    send: () => engine.send(own, kp, { to: peer, text: 'oi' }, recipientBox),
    set: () => engine.set(own, kp, { peer, state: 'accepted' })
  }
}

test('dm.send emits an empty dm.sending before each recipient and self-copy put', async (t) => {
  const { send, calls } = await sendingEngine(t)
  t.ok((await send()).id)
  t.alike(calls, [['dm.sending', {}], ['put'], ['dm.sending', {}], ['put']], 'each put is preceded by its own empty event')
})

test('dm.set emits an empty dm.sending before the ctl flush put', async (t) => {
  const { set, calls, storage } = await sendingEngine(t)
  t.alike(await set(), { ok: true })
  t.alike(calls, [['dm.sending', {}], ['put']], 'one event before the ctl put')
  t.alike(await store.readDmCtlQueue(storage), [])
})

test('a throwing send put is still preceded by dm.sending', async (t) => {
  const { send, calls, engine } = await sendingEngine(t, { failPut: true })
  const err = await errorOf(send())
  t.is(err && err.message, 'não deu para confirmar o envio')
  t.is(err && err.uncertain, true)
  await engine.idle()
  t.alike(calls, [['dm.sending', {}], ['put']], 'one attempted put and no automatic resend')
})

test('a throwing ctl put and its later unlock flush each emit dm.sending first', async (t) => {
  const { set, calls, engine, storage, prf, link } = await sendingEngine(t, { stamps: 1, failPut: true })
  t.alike(await set(), { ok: true })
  t.alike(calls, [['dm.sending', {}], ['put']], 'the failed ctl put was announced')
  t.is((await store.readDmCtlQueue(storage)).length, 1)
  engine.lock()
  link.failPut = false
  calls.length = 0
  await engine.unlock(prf)
  await engine.idle()
  t.alike(calls, [['dm.sending', {}], ['put']], 'unlock announces the queued stamped ctl before putting it')
  t.alike(await store.readDmCtlQueue(storage), [])
})

test('no dm.sending or put when send and ctl flush have no stamps', async (t) => {
  const { send, set, calls, engine, storage, prf } = await sendingEngine(t, { stamps: 0 })
  const err = await errorOf(send())
  t.is(err && err.message, 'o limite de envio de hoje acabou')
  t.alike(calls, [], 'an unstamped send emits nothing')
  t.alike(await set(), { ok: true })
  t.is((await store.readDmCtlQueue(storage)).length, 1)
  t.alike(calls, [], 'an unstamped ctl stays queued without an event')
  engine.lock()
  await engine.unlock(prf)
  await engine.idle()
  t.alike(calls, [], 'unlock without stamps still emits nothing')
})

test('a send whose local filing failed files on the retry without a re-put', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  let fail = true
  const { engine, storage } = engineFor(t, seeder, {
    createStore: (o) => {
      const s = createDmStore(o)
      return {
        ...s,
        append (rows) {
          if (fail && rows[0].t === 'msg') {
            fail = false
            return Promise.reject(new Error('disco cheio'))
          }
          return s.append(rows)
        }
      }
    }
  })
  const kp = crypto.keyPair()
  const own = hex(kp.publicKey)
  await certify(storage, kp, assoc)
  await engine.unlock(crypto.randomBytes(32))
  t.ok((await engine.topUp(kp, { force: true })) > 0)
  const to = crypto.keyPair()
  const toBox = hex((await dmBoxKeyPairFromPrf(crypto.randomBytes(32), 1)).publicKey)
  const err = await errorOf(engine.send(own, kp, { to: hex(to.publicKey), text: 'oi' }, toBox))
  t.is(err && err.message, 'disco cheio')
  t.is(seeder.puts.length, 1, 'the recipient drop was acked, then the filing failed')
  const ok = await engine.send(own, kp, { to: hex(to.publicKey), text: 'oi' }, toBox)
  t.ok(ok.id)
  t.is(seeder.puts.length, 2, 'only the self copy is put: no re-put of the recipient drop')
  t.absent(b4a.equals(seeder.puts[0], seeder.puts[1]))
  t.is((await engine.thread(own, { peer: hex(to.publicKey) })).messages.length, 1, 'filed once')
})

test('a failed top-up backs off 60 s, not 10 minutes', async (t) => {
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  await seeder.close()
  // The blob wallet's top-up runs next to it and dials once, then waits
  // its own (default) 60 s back-off.
  const { engine, sockets } = engineFor(t, seeder, { limits: { topUpRetryMs: 100 } })
  await engine.unlock(crypto.randomBytes(32))
  const kp = crypto.keyPair()
  t.is(await engine.topUp(kp), 0)
  await engine.idle()
  t.is(sockets.length, 2, 'one DM and one blob dial')
  t.is(await engine.topUp(kp), 0)
  await engine.idle()
  t.is(sockets.length, 2, 'within the back-off: no dial')
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine.topUp(kp)
  await engine.idle()
  t.is(sockets.length, 3, 'after the back-off: the DM wallet dials again')
})

test('reset waits for a pull in flight before deleting the store', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const pulling = errorOf(A.web.request('dm.pull'))
  await A.node.reset()
  await pulling
  t.absent(await A.storage.hasCore(store.DM_LOCAL), 'the store is gone after reset')
  t.is(await A.storage.readJson('dmStamps'), null)
})

test('dm.thread carries its folder and block state; dm.list says when any inbox thread is unread', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await copyDiary(A, C)
  await B.web.request('dm.send', { to: A.key, text: 'de B' })
  await A.web.request('dm.pull')
  let th = await A.web.request('dm.thread', { peer: B.key })
  t.is(th.folder, 'request')
  t.is(th.blocked, false)
  t.is(th.messages[0].from, B.key, 'rows carry from')
  await A.web.request('dm.set', { peer: B.key, state: 'accepted' })
  th = await A.web.request('dm.thread', { peer: B.key })
  t.is(th.folder, 'inbox')

  // B's thread is older and unread; C's newer one is read: page 1 holds C only.
  await C.web.request('dm.send', { to: A.key, text: 'de C' })
  await A.web.request('dm.pull')
  await A.web.request('dm.set', { peer: C.key, state: 'accepted' })
  await A.web.request('dm.seen', { peer: C.key })
  const page = await A.web.request('dm.list', { limit: 1 })
  t.is(page.conversations.length, 1)
  t.is(page.conversations[0].peer, C.key)
  t.is(page.conversations[0].unread, false)
  t.ok(page.next !== null)
  t.is(page.inboxUnread, true, 'an unread inbox thread beyond the first page')
  await A.web.request('dm.seen', { peer: B.key })
  t.is((await A.web.request('dm.list', { limit: 1 })).inboxUnread, false)

  await A.web.request('dm.set', { peer: B.key, state: 'blocked' })
  th = await A.web.request('dm.thread', { peer: B.key })
  t.is(th.blocked, true)
  t.is(th.messages.length, 0)
  t.is(th.folder, 'inbox')
})

test('an empty thread with a peer not followed is inbox (the composer shows); the peer\'s first message makes it a request', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  t.alike(await A.web.request('dm.thread', { peer: B.key }), { messages: [], next: null, folder: 'inbox', blocked: false })
  await B.web.request('dm.send', { to: A.key, text: 'primeira' })
  await A.web.request('dm.pull')
  const th = await A.web.request('dm.thread', { peer: B.key })
  t.is(th.folder, 'request')
  t.is(th.messages.length, 1)
})

test('a blocked ctl and a later message from that peer in one pull page: added 0', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  // A's other device files nothing yet: it pulls the ctl and B's message in
  // the same page, in that order.
  const A2 = await memberNode(t, assoc, seeder.url, { keyPair: A.keyPair, prf: A.prf, enable: false })
  await A.web.request('dm.set', { peer: B.key, state: 'blocked' })
  await B.web.request('dm.send', { to: A.key, text: 'bloqueado' })
  A2.web.events.length = 0
  const r = await A2.web.request('dm.pull')
  t.is(r.added, 0, 'the message after the block in the same page is not counted')
  t.absent(A2.web.events.some((e) => e.name === 'dm.changed' && e.data.added > 0))
  t.is((await A2.web.request('dm.thread', { peer: B.key })).blocked, true)
})

test('a ctl whose put failed is queued and flushed on unlock and on the next dm.set, never by a top-up; a refused one is dropped', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  let cut = false
  const seeder = await dmSeeder(t, { signer: assoc, dropPutAck: (n) => cut && n === seeder.puts.length - 1 && !(cut = false) })
  const A = await memberNode(t, assoc, seeder.url, { dm: { topUpEveryMs: 0, topUpRetryMs: 0 } })
  const peer = 'ef'.repeat(32)
  const queue = async () => ((await A.storage.readJson('dmCtlQueue')) || { items: [] }).items.length

  cut = true
  t.alike(await A.web.request('dm.set', { peer, state: 'accepted' }), { ok: true })
  t.is(await queue(), 1, 'an unacked ctl is queued')
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(async () => (await queue()) === 0)
  t.pass('flushed on unlock')

  cut = true
  await A.web.request('dm.set', { peer, state: 'blocked' })
  t.is(await queue(), 1)
  const minted = seeder.stampProofs.length
  t.ok((await wallet(A.storage)) >= dmCore.DM_STAMP_WALLET_LOW, 'the wallet is full')
  await A.web.request('dm.enable')
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(await queue(), 1, 'a top-up does not put the queue')
  await A.web.request('dm.set', { peer, state: 'declined' })
  t.is(await queue(), 0, 'flushed by the next dm.set')
  t.is(seeder.stampProofs.length, minted, 'flushed without minting')

  // A stamp the pool refuses: the ctl is dropped, not queued.
  const local = await opener(A.prf)
  const w = await A.storage.readJson('dmStamps')
  const first = local.open(w.items[0])
  first.sig = local.open(w.items[1]).sig
  w.items[0] = { kid: w.items[0].kid, ...local.seal(first) }
  await A.storage.writeJson('dmStamps', w)
  await A.web.request('dm.set', { peer, state: 'unblocked' })
  t.is(await queue(), 0, 'a refused ctl is not queued')
  t.ok(A.web.events.some((e) => e.name === 'warning' && /recusado/.test(e.data.line)))
})

test('dm.thread: an unknown before pages from the newest', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  for (const text of ['um', 'dois', 'três']) await B.web.request('dm.send', { to: A.key, text })
  await A.web.request('dm.pull')
  const page = await A.web.request('dm.thread', { peer: B.key, before: 'f'.repeat(32), limit: 2 })
  t.alike(page.messages.map((m) => m.text), ['dois', 'três'])
  const older = await A.web.request('dm.thread', { peer: B.key, before: page.next, limit: 2 })
  t.alike(older.messages.map((m) => m.text), ['um'])
  t.is(older.next, null)
})

test('dmLookup needs no identity and never deletes a replica', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url, { enable: false })
  const reader = { storage: memoryNodeStorage() }
  await copyDiary(A, reader)
  t.is(await member.dmLookup({ storage: reader.storage }, A.key), null, 'no dm-key in the replica: null (the session peeks)')
  t.ok(await store.replicaExists(reader.storage, A.key), 'the replica stays')
  const { box } = await A.web.request('dm.enable')
  await copyDiary(A, reader)
  t.alike(await member.dmLookup({ storage: reader.storage }, A.key), { box, gen: 1 })
})

test('a failed unlock leaves the engine locked', async (t) => {
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const { engine } = engineFor(t, seeder, {
    createStore: (o) => ({ ...createDmStore(o), unlock: () => Promise.reject(new Error('disco')) })
  })
  const err = await errorOf(engine.unlock(crypto.randomBytes(32)))
  t.is(err && err.message, 'disco')
  t.absent(engine.unlocked())
  t.exception(() => engine.boxHex(), /bloqueada/)
})

// A PNG header the media bounds accept, then `size` random IDAT bytes.
function png (size) {
  const out = b4a.alloc(8 + 25 + 12 + size)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  out.writeUInt32BE(13, 8)
  out.write('IHDR', 12, 'ascii')
  out.writeUInt32BE(64, 16)
  out.writeUInt32BE(48, 20)
  out[24] = 8
  out[25] = 6
  out.writeUInt32BE(size, 33)
  out.write('IDAT', 37, 'ascii')
  out.fill(7, 41)
  return out
}

test('a failed photo upload is a normal error and sends nothing; an item not put here is refused', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  // The stand-in has no blob channel or blob key: every blob step fails.
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url, { dm: { blob: { wallet: 4, walletLow: 2, issuePaceMs: 0 } } })
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(B, A)
  const puts = seeder.puts.length

  const err = await A.node.dmPutMedia({ bytes: png(100), mime: 'image/png', width: 64, height: 48 }).then(() => null, (e) => e)
  t.ok(err !== null, 'the upload fails')
  t.not(err.message, 'não deu para confirmar o envio', 'not the uncertain signal of dm.send')
  t.not(err.message, 'não deu para confirmar o envio da mídia')
  t.absent(err.uncertain, 'never uncertain')
  t.exception.all(() => A.node.dmPutMedia({ bytes: png(100), mime: 'image/bmp', width: 64, height: 48 }), /mídia inválida/, 'a mime outside the list is refused at once')
  const bad = await A.node.dmPutMedia({ bytes: b4a.from('not an image'), mime: 'image/png', width: 64, height: 48 }).then(() => null, (e) => e)
  t.is(bad.message, 'mídia inválida', 'bytes that fail the media bounds are refused')

  const item = { id: 'ab'.repeat(32), key: 'cd'.repeat(32), nonce: 'ef'.repeat(24), chunks: 1, bytes: 1000, sha256: '12'.repeat(32), mime: 'image/png', w: 64, h: 48, ms: 0 }
  const refused = await errorOf(A.web.request('dm.send', { to: B.key, text: 'legenda', media: [item] }))
  t.is(refused.message, 'prepare a mídia de novo', 'an item this node did not put')
  t.is(seeder.puts.length, puts, 'no drop was put')
  t.is((await A.web.request('dm.list', {})).conversations.length, 0, 'nothing filed')
})

// A minimal MPEG-4 audio file (ftyp, moov with mvhd and one trak per
// handler, mdat): enough for audioBounds.
function m4a ({ ms = 3000, handlers = ['soun'], pad = 0 } = {}) {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  // A real sound track: mdhd timescale 1000, a self-contained data reference,
  // one mp4a sample entry and a sample table as long as `ms`.
  const trak = (h) => box('trak', box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii(h), be32(0), be32(0), be32(0), [0]), box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 25, 0, 1, 0, 4, 17, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 18, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(1), be32(ms)), box('stsz', [0, 0, 0, 0], be32(1), be32(1)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(1), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))))
  return b4a.from([
    ...box('ftyp', ascii('M4A '), be32(0), ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0)), ...handlers.map(trak)),
    ...box('mdat', new Array(pad).fill(9))
  ])
}

test('a voice note for dm.send: audio only, no sides, its duration; checked before the put', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  // The stand-in has no blob channel: a voice note that passes the checks
  // fails at the put, like a photo, never as 'mídia inválida'.
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url, { dm: { blob: { wallet: 4, walletLow: 2, issuePaceMs: 0 } } })
  const voice = { bytes: m4a({ pad: 200 }), mime: 'audio/mp4', width: 0, height: 0, ms: 3000, kind: 'voice' }
  const err = await A.node.dmPutMedia(voice).then(() => null, (e) => e)
  t.ok(err !== null, 'the upload fails at the blob channel')
  t.not(err.message, 'mídia inválida', 'the voice note itself passed')
  t.absent(err.uncertain, 'never uncertain')

  const bad = {
    'a video track': { bytes: m4a({ handlers: ['soun', 'vide'] }) },
    'not MPEG-4': { bytes: b4a.alloc(3000, 1) },
    'over the byte cap': { bytes: b4a.concat([m4a(), b4a.alloc(1572864)]) },
    'ms 0': { ms: 0 },
    'ms over': { ms: 120001 },
    'with sides': { width: 64, height: 48 },
    'another audio mime': { mime: 'audio/ogg' },
    'no kind': { kind: undefined }
  }
  for (const [name, over] of Object.entries(bad)) {
    t.exception.all(() => A.node.dmPutMedia({ ...voice, ...over }), /mídia inválida/, name)
  }
  t.exception.all(() => A.node.dmPutMedia({ bytes: png(100), mime: 'image/png', width: 0, height: 0 }), /mídia inválida/, 'a photo still needs its sides')
})

test('the dm engine opens a voice note only when its bytes are audio only', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const { engine, storage } = engineFor(t, seeder)
  const kp = crypto.keyPair()
  await certify(storage, kp, assoc)
  await engine.unlock(crypto.randomBytes(32))
  const own = hex(kp.publicKey)
  const putErr = async (args) => (await errorOf(engine.putMedia(own, kp, args))).message
  t.is(await putErr({ bytes: m4a({ handlers: ['soun', 'vide'] }), mime: 'audio/mp4', width: 0, height: 0, ms: 3000 }), 'mídia inválida', 'a video track')
  t.is(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0, ms: 0 }), 'mídia inválida', 'ms 0')
  t.is(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 1, height: 1, ms: 3000 }), 'mídia inválida', 'sides')
  t.is(await putErr({ bytes: png(100), mime: 'image/png', width: 64, height: 48, ms: 10 }), 'mídia inválida', 'a photo with a duration')
  t.not(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0, ms: 3000 }), 'mídia inválida', 'a voice note reaches the put')
  t.is(await putErr({ bytes: m4a({ ms: 120000 }), mime: 'audio/mp4', width: 0, height: 0, ms: 1 }), 'mídia inválida', 'two minutes claiming 1 ms')
  t.is(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0, ms: 4001 }), 'mídia inválida', 'past the tolerance')
  t.not(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0 }), 'mídia inválida', 'no ms: the container decides')
})

test('voiceMs: a voice note opens only when its item ms matches the container', (t) => {
  const { AUDIO_MS_TOLERANCE } = require('@varanda/rpc')
  t.is(AUDIO_MS_TOLERANCE, 1000)
  t.is(voiceMs(m4a(), undefined), 3000, 'the container duration')
  t.is(voiceMs(m4a(), 3000), 3000)
  t.is(voiceMs(m4a(), 2000), 3000, 'a rounded ms within the tolerance')
  t.is(voiceMs(m4a(), 4000), 3000)
  t.is(voiceMs(m4a(), 1999), null, 'too short')
  t.is(voiceMs(m4a(), 4001), null, 'too long')
  t.is(voiceMs(m4a({ ms: 120000 }), 1), null, 'two minutes claiming 1 ms')
  t.is(voiceMs(m4a(), '3000'), null, 'not a number')
  t.is(voiceMs(m4a({ handlers: ['soun', 'vide'] }), 3000), null, 'a video track')
})
