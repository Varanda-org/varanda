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
const { createCert, createModeratorCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const dmCore = require('@varanda/core/lib/dm')
const { verifyDmReport } = require('@varanda/core/lib/report')
const { createBrowserNode } = require('../lib/node')
const { createDmEngine, voiceMs } = require('../lib/dm')
const { createDmStore } = require('../lib/dm-store')
const { createGroupKeys } = require('../lib/group-keys')
const member = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf, groupKeyPairFromPrf } = require('../lib/passkey')
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
  const card = { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: '', image: null }
  const sent = await B.web.request('dm.send', { to: A.key, text: SECRET, fwd: 1, card })
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
  t.is(thread.messages[0].fwd, 1, 'received forward')
  t.alike(thread.messages[0].card, card)
  t.is((await B.web.request('dm.thread', { peer: A.key })).messages[0].fwd, 1, 'locally filed forward')
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
  t.alike(t2.messages.map(m => m.fwd), [1, 0], 'self copies retain forward and v1 flags')
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
  await engine.loaded()
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
  await engine.loaded()
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
    transport.openDmLink = async () => {
      if (link.offline) throw new Error('offline')
      if (link.onOpen) await link.onOpen()
      return link
    }
    delete require.cache[id]
    return require('../lib/dm').createDmEngine
  } finally {
    transport.openDmLink = original
    require.cache[id] = cached
  }
}

async function sendingEngine (t, { stamps = 2, failPut = false, options = {} } = {}) {
  const calls = []
  const link = {
    failPut,
    // The bucket prefix each put was given, in order.
    prefixes: [],
    async put (bytes, prefix) {
      calls.push(['put'])
      link.prefixes.push(prefix === undefined ? null : prefix)
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
    emit: (name, data) => calls.push([name, data]),
    ...options
  })
  t.teardown(() => engine.close(), { force: true })
  await certify(storage, kp, assoc)
  await engine.unlock(prf)
  await engine.loaded()
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
    own,
    association: hex(assoc.publicKey),
    kp,
    peer,
    recipientBox,
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
  await engine.loaded()
  await engine.idle()
  t.alike(calls, [['dm.sending', {}], ['put']], 'unlock announces the queued stamped ctl before putting it')
  t.alike(await store.readDmCtlQueue(storage), [])
})

test('a lock while the pull opens its link fails with the locked message, not a TypeError', async (t) => {
  const { engine, link, own } = await sendingEngine(t)
  link.onOpen = () => engine.lock()
  link.page = async () => ({ items: [], next: null, oldest: 0 })
  const err = await errorOf(engine.pull(own))
  t.is(err && err.message, LOCKED)
  t.is(err && err.constructor.name, 'UsageError')
})

test('a lock while a ctl flush opens its link puts nothing; the stamped ctl goes out at the next unlock', async (t) => {
  const { set, calls, engine, link, storage, prf } = await sendingEngine(t)
  link.onOpen = () => engine.lock()
  t.alike(await set(), { ok: true })
  t.alike(calls, [], 'no dm.sending and no put after the lock')
  t.is((await store.readDmCtlQueue(storage)).length, 1, 'still queued')
  link.onOpen = null
  await engine.unlock(prf)
  await engine.loaded()
  await engine.idle()
  t.alike(calls, [['dm.sending', {}], ['put']], 'put at the next unlock')
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
  await engine.loaded()
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
  await engine.loaded()
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
  await engine.loaded()
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

  const err = await A.node.dmPutMedia({ bytes: png(100), mime: 'image/png', width: 64, height: 48, to: B.key }).then(() => null, (e) => e)
  t.ok(err !== null, 'the upload fails')
  t.not(err.message, 'não deu para confirmar o envio', 'not the uncertain signal of dm.send')
  t.not(err.message, 'não deu para confirmar o envio da mídia')
  t.absent(err.uncertain, 'never uncertain')
  t.exception.all(() => A.node.dmPutMedia({ bytes: png(100), mime: 'image/bmp', width: 64, height: 48, to: B.key }), /mídia inválida/, 'a mime outside the list is refused at once')
  const bad = await A.node.dmPutMedia({ bytes: b4a.from('not an image'), mime: 'image/png', width: 64, height: 48, to: B.key }).then(() => null, (e) => e)
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
  // one mp4a sample entry (AAC at an explicit 1024000 Hz: a 1024-sample
  // access unit lasts 1 ms) and `ms` samples of one tick; the mdat holds at
  // least their one byte each.
  const trak = (h) => box('trak', box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii(h), be32(0), be32(0), be32(0), [0]), box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 28, 0, 1, 0, 4, 20, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 23, 135, 208, 0, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(ms), be32(1)), box('stsz', [0, 0, 0, 0], be32(1), be32(ms)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(ms), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))))
  return b4a.from([
    ...box('ftyp', ascii('M4A '), be32(0), ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0)), ...handlers.map(trak)),
    ...box('mdat', new Array(Math.max(pad, ms)).fill(9))
  ])
}

test('a voice note for dm.send: audio only, no sides, its duration; checked before the put', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  // The stand-in has no blob channel: a voice note that passes the checks
  // fails at the put, like a photo, never as 'mídia inválida'.
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url, { dm: { blob: { wallet: 4, walletLow: 2, issuePaceMs: 0 } } })
  const voice = { bytes: m4a({ pad: 200 }), mime: 'audio/mp4', width: 0, height: 0, ms: 3000, kind: 'voice', to: 'ab'.repeat(32) }
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
  t.exception.all(() => A.node.dmPutMedia({ bytes: png(100), mime: 'image/png', width: 0, height: 0, to: 'ab'.repeat(32) }), /mídia inválida/, 'a photo still needs its sides')
  // A chat takes no video: refused at once whatever the label.
  const to = 'ab'.repeat(32)
  const clip = m4a({ handlers: ['vide'] })
  t.exception.all(() => A.node.dmPutMedia({ bytes: clip, mime: 'video/mp4', width: 640, height: 360, ms: 3000, kind: 'video', to }), /mídia inválida/, 'a video')
  t.exception.all(() => A.node.dmPutMedia({ bytes: clip, mime: 'video/mp4', width: 640, height: 360, to }), /mídia inválida/, 'a video without kind')
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
  await engine.loaded()
  const own = hex(kp.publicKey)
  const to = hex(crypto.keyPair().publicKey)
  const putErr = async (args) => (await errorOf(engine.putMedia(own, kp, { to, ...args }))).message
  t.is(await putErr({ bytes: m4a({ handlers: ['soun', 'vide'] }), mime: 'audio/mp4', width: 0, height: 0, ms: 3000 }), 'mídia inválida', 'a video track')
  t.is(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0, ms: 0 }), 'mídia inválida', 'ms 0')
  t.is(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 1, height: 1, ms: 3000 }), 'mídia inválida', 'sides')
  t.is(await putErr({ bytes: png(100), mime: 'image/png', width: 64, height: 48, ms: 10 }), 'mídia inválida', 'a photo with a duration')
  t.not(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0, ms: 3000 }), 'mídia inválida', 'a voice note reaches the put')
  t.is(await putErr({ bytes: m4a({ ms: 120000 }), mime: 'audio/mp4', width: 0, height: 0, ms: 1 }), 'mídia inválida', 'two minutes claiming 1 ms')
  t.is(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0, ms: 4001 }), 'mídia inválida', 'past the tolerance')
  t.not(await putErr({ bytes: m4a(), mime: 'audio/mp4', width: 0, height: 0 }), 'mídia inválida', 'no ms: the container decides')
  t.is(await putErr({ bytes: m4a({ handlers: ['vide'] }), mime: 'video/mp4', width: 640, height: 360, ms: 3000 }), 'mídia inválida', 'the engine refuses a video for a chat')
})

// A dm engine whose blob channel is a stand-in that acks every frame at once
// (the loopback seeder has none): lib/dm.js loaded again over a stubbed
// ./blob createBlobClient, the require cache restored right after.
function engineWithBlobs (t, seeder, sent) {
  const blobPath = require.resolve('../lib/blob')
  const dmPath = require.resolve('../lib/dm')
  const realBlob = require(blobPath)
  const realDm = require.cache[dmPath]
  const fake = {
    ...realBlob,
    createBlobClient: () => ({
      async send (sealed) {
        sent.push(sealed.descriptor.id)
        sealed.acked.fill(true)
      },
      walletSize: async () => 1000,
      topUp: async () => 0
    })
  }
  delete require.cache[dmPath]
  require.cache[blobPath].exports = fake
  let create
  try {
    create = require(dmPath).createDmEngine
  } finally {
    require.cache[blobPath].exports = realBlob
    require.cache[dmPath] = realDm
  }
  const storage = memoryNodeStorage()
  const engine = create({
    storage,
    association: seeder.assoc,
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    limits: { issuePaceMs: 0 }
  })
  t.teardown(() => engine.close(), { force: true })
  return { engine, storage }
}

// The forward audit: an uncertain send keeps its sealed blob for the retry,
// and the same photo then forwarded to another conversation must not carry
// that blob (the seeder would link the readers of both conversations).
test('dm putMedia: one sealed blob per destination, even after an uncertain send; a retry to the same one reuses it', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  let cut = false
  const seeder = await dmSeeder(t, { signer: assoc, dropPutAck: (n) => cut && n === seeder.puts.length - 1 && !(cut = false) })
  seeder.assoc = hex(assoc.publicKey)
  const sent = []
  const { engine, storage } = engineWithBlobs(t, seeder, sent)
  const kp = crypto.keyPair()
  const own = hex(kp.publicKey)
  await certify(storage, kp, assoc)
  await engine.unlock(crypto.randomBytes(32))
  await engine.loaded()
  t.ok((await engine.topUp(kp, { force: true })) > 0)
  const first = hex(crypto.keyPair().publicKey)
  const second = hex(crypto.keyPair().publicKey)
  const firstBox = hex((await dmBoxKeyPairFromPrf(crypto.randomBytes(32), 1)).publicKey)
  const photo = { mime: 'image/png', width: 64, height: 48 }

  const toFirst = await engine.putMedia(own, kp, { ...photo, bytes: png(100), to: first })
  cut = true
  const err = await errorOf(engine.send(own, kp, { to: first, text: '', media: [toFirst], fwd: 1 }, firstBox))
  t.is(err && err.message, 'não deu para confirmar o envio', 'the first send is uncertain')

  const toSecond = await engine.putMedia(own, kp, { ...photo, bytes: png(100), to: second })
  for (const k of ['id', 'key', 'nonce', 'sha256']) t.not(toSecond[k], toFirst[k], 'the second destination gets its own ' + k)
  t.alike(sent, [toFirst.id, toSecond.id], 'two blobs put')

  const retry = await engine.putMedia(own, kp, { ...photo, bytes: png(100), to: first })
  t.alike(retry, toFirst, 'a retry to the first destination reuses its blob')
  t.is(sent.length, 2, 'acked frames are not put again')

  // The item is bound to its destination: the first one's item sent to the
  // second conversation is refused before anything goes out.
  const secondBox = hex((await dmBoxKeyPairFromPrf(crypto.randomBytes(32), 1)).publicKey)
  const drops = seeder.puts.length
  const crossed = await errorOf(engine.send(own, kp, { to: second, text: '', media: [retry], fwd: 1 }, secondBox))
  t.is(crossed && crossed.message, 'prepare a mídia de novo', 'an item put for another destination is refused')
  t.is(seeder.puts.length, drops, 'no drop was put')
  t.is(sent.length, 2, 'no blob was put')

  const resent = await errorOf(engine.send(own, kp, { to: first, text: '', media: [retry], fwd: 1 }, firstBox))
  t.is(resent, null, 'the retry to the first destination with its own item goes out')

  for (const to of [undefined, 'AB'.repeat(32), 'ab', 1, null]) {
    t.is((await errorOf(engine.putMedia(own, kp, { ...photo, bytes: png(100), to }))).message, 'mídia inválida', 'to ' + JSON.stringify(to))
  }
})

test('dmPutMedia refuses a missing to, or one that is not a lowercase hex64 key, at once', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url, { dm: { blob: { wallet: 4, walletLow: 2, issuePaceMs: 0 } } })
  for (const to of [undefined, 'AB'.repeat(32), 'ab', 1, null, ['ab'.repeat(32)]]) {
    // Thrown synchronously, before the engine (which refuses it too) runs.
    let threw = null
    try {
      A.node.dmPutMedia({ bytes: png(100), mime: 'image/png', width: 64, height: 48, to }).catch(() => {})
    } catch (err) {
      threw = err
    }
    t.ok(threw instanceof TypeError && threw.message === 'mídia inválida', 'to ' + JSON.stringify(to))
  }
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

test('chat forwards: browser group writes and reads keep flags in public and private posts', async (t) => {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const assoc = generateAssociationKeyPair()
  const groupKeys = createGroupKeys()
  t.teardown(() => groupKeys.lock())
  const ctx = { storage, keyPair, association: hex(assoc.publicKey), groupKeys, groupKeyPair: nonce => groupKeyPairFromPrf(prf, nonce) }
  await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: hex(keyPair.publicKey) }, assoc))
  await groupKeys.unlock(storage, new Uint8Array(prf))
  const { community, group: general } = await member.communityCreate(ctx, { name: 'Bairro', join: 'open' })
  const { group: privateGroup } = await member.groupCreate(ctx, { community, name: 'Segredo', join: 'approval', visibility: 'private' })
  for (const group of [general, privateGroup]) {
    await member.groupPost(ctx, { group, text: 'original' })
    const sent = await member.groupPost(ctx, { group, text: 'encaminhada', fwd: 1 })
    const read = await member.groupRead(ctx, { group })
    t.alike(read.items.map(p => [p.text, p.fwd]), [['encaminhada', 1], ['original', 0]])
    t.is(read.items[0].media, null)
    const core = await store.openGroupCoreReadOnly(storage, group)
    try {
      const record = JSON.parse(b4a.toString(await core.get(sent.seq)))
      t.is(record.type, group === general ? 'group-post' : 'group-sealed')
    } finally {
      await core.close()
    }
  }
})

test('DM cards bind their thumbnail to the recipient and survive ingestion, reopen and reads', async (t) => {
  const blob = require('@varanda/core/lib/blob')
  const blobPath = require.resolve('../lib/blob')
  const realBlob = require(blobPath)
  const frames = new Map()
  const gets = []
  const options = {
    mediaOrigin: 'http://127.0.0.1',
    fetch: async (url) => {
      gets.push(url)
      return new Response(frames.get(url), { status: frames.has(url) ? 200 : 404 })
    }
  }
  require.cache[blobPath].exports = {
    ...realBlob,
    createBlobClient: () => ({
      async send (sealed) {
        for (let i = 0; i < sealed.descriptor.chunks; i++) {
          const frame = blob.encodeChunk({ id: sealed.id, index: i, count: sealed.descriptor.chunks, kid: b4a.alloc(8), sig: b4a.alloc(dmCore.DROP.SIG_BYTES), token: b4a.alloc(32), bytes: sealed.cipher.subarray(i * blob.BLOB_CHUNK_BYTES, (i + 1) * blob.BLOB_CHUNK_BYTES) })
          frames.set('http://127.0.0.1/blob/' + sealed.descriptor.id + '/' + i, frame)
        }
        sealed.acked.fill(true)
      },
      walletSize: async () => 1000,
      topUp: async () => 0
    })
  }
  let s
  try { s = await sendingEngine(t, { stamps: 4, options }) } finally { require.cache[blobPath].exports = realBlob }
  const drops = []
  s.link.put = async (bytes) => { drops.push(new Uint8Array(bytes)); return { ok: true, reason: null } }
  s.link.page = async () => ({ items: drops.map((bytes, i) => ({ bytes, seq: i + 1 })), next: null })
  const bytes = new Uint8Array([255, 216, 255, 192, 0, 17, 8, 0, 48, 0, 64, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 2, 255, 217])
  const image = await s.engine.putMedia(s.own, s.kp, { bytes: new Uint8Array(bytes), mime: 'image/jpeg', width: 64, height: 48, to: s.peer })
  const card = { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: '', image }
  const wrong = await errorOf(s.engine.send(s.own, s.kp, { to: hex(crypto.keyPair().publicKey), text: 'link', card }, s.recipientBox))
  t.is(wrong && wrong.message, 'prepare a mídia de novo')
  t.is(drops.length, 0)
  const sent = await s.engine.send(s.own, s.kp, { to: s.peer, text: 'link', card }, s.recipientBox)
  t.alike((await s.engine.thread(s.own, { peer: s.peer })).messages[0].card, card)
  t.ok(b4a.equals((await s.engine.readMedia(s.own, { from: s.own, id: sent.id, index: 'card' })).bytes, bytes))
  t.is(gets.length, 0, 'the sender reads its cached plaintext')
  const numeric = await errorOf(s.engine.readMedia(s.own, { from: s.own, id: sent.id, index: 0 }))
  t.is(numeric && numeric.message, 'mídia indisponível', 'numeric indices name media only')

  const storage = memoryNodeStorage()
  const create = engineWithDmLink(s.link)
  const other = create({ storage, association: s.association, ...options })
  t.teardown(() => other.close(), { force: true })
  await other.unlock(s.prf)
  await other.loaded()
  t.is((await other.pull(s.own)).added, 1, 'the self copy is ingested by another device')
  t.alike((await other.thread(s.own, { peer: s.peer })).messages[0].card, card)
  const opened = await other.readMedia(s.own, { from: s.own, id: sent.id, index: 'card' })
  t.alike(opened, { bytes, mime: 'image/jpeg' })
  t.is(gets.length, 1, 'the thumbnail was fetched and verified')
  other.lock()
  await other.unlock(s.prf)
  await other.loaded()
  t.alike((await other.thread(s.own, { peer: s.peer })).messages[0].card, card)
  t.ok(b4a.equals((await other.readMedia(s.own, { from: s.own, id: sent.id, index: 'card' })).bytes, bytes))
  t.is(gets.length, 1, 'the reopened cache supplies the thumbnail')
  await s.engine.set(s.own, s.kp, { peer: s.peer, state: 'deleted' })
  t.is((await errorOf(s.engine.readMedia(s.own, { from: s.own, id: sent.id, index: 'card' }))).message, 'mídia indisponível')
  other.lock()
  t.is((await errorOf(other.readMedia(s.own, { from: s.own, id: sent.id, index: 'card' }))).message, LOCKED)
})

test('a photo still downloading when its conversation is deleted is not cached afterwards', async (t) => {
  const blob = require('@varanda/core/lib/blob')
  const blobPath = require.resolve('../lib/blob')
  const realBlob = require(blobPath)
  const frames = new Map()
  const gate = { held: false, release: null, wait: null }
  const options = {
    mediaOrigin: 'http://127.0.0.1',
    fetch: async (url) => {
      if (gate.held) await gate.wait
      return new Response(frames.get(url), { status: frames.has(url) ? 200 : 404 })
    }
  }
  require.cache[blobPath].exports = {
    ...realBlob,
    createBlobClient: () => ({
      async send (sealed) {
        for (let i = 0; i < sealed.descriptor.chunks; i++) {
          const frame = blob.encodeChunk({ id: sealed.id, index: i, count: sealed.descriptor.chunks, kid: b4a.alloc(8), sig: b4a.alloc(dmCore.DROP.SIG_BYTES), token: b4a.alloc(32), bytes: sealed.cipher.subarray(i * blob.BLOB_CHUNK_BYTES, (i + 1) * blob.BLOB_CHUNK_BYTES) })
          frames.set('http://127.0.0.1/blob/' + sealed.descriptor.id + '/' + i, frame)
        }
        sealed.acked.fill(true)
      },
      walletSize: async () => 1000,
      topUp: async () => 0
    })
  }
  let s
  try { s = await sendingEngine(t, { stamps: 4, options }) } finally { require.cache[blobPath].exports = realBlob }
  const drops = []
  s.link.put = async (bytes) => { drops.push(new Uint8Array(bytes)); return { ok: true, reason: null } }
  s.link.page = async () => ({ items: drops.map((bytes, i) => ({ bytes, seq: i + 1 })), next: null })
  const bytes = new Uint8Array([255, 216, 255, 192, 0, 17, 8, 0, 48, 0, 64, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 2, 255, 217])
  const image = await s.engine.putMedia(s.own, s.kp, { bytes: new Uint8Array(bytes), mime: 'image/jpeg', width: 64, height: 48, to: s.peer })
  const sent = await s.engine.send(s.own, s.kp, { to: s.peer, text: 'link', card: { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: '', image } }, s.recipientBox)

  const storage = memoryNodeStorage()
  const other = engineWithDmLink(s.link)({ storage, association: s.association, ...options })
  t.teardown(() => other.close(), { force: true })
  await other.unlock(s.prf)
  await other.loaded()
  t.is((await other.pull(s.own)).added, 1, 'the self copy is ingested by another device')
  const cached = async () => ((await storage.readJson('dmMediaIndex')) || { items: [] }).items.length

  gate.held = true
  gate.wait = new Promise((resolve) => { gate.release = resolve })
  const reading = other.readMedia(s.own, { from: s.own, id: sent.id, index: 'card' }).catch(() => null)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await other.set(s.own, s.kp, { peer: s.peer, state: 'deleted' })
  gate.release()
  await reading
  await other.idle()
  t.is(await cached(), 0, 'nothing was cached for the deleted message')
})

test('dm.react: two stamps and two puts as one dm.send; a no-op sends nothing; a missing target or no stamps refuses', async (t) => {
  const { engine, storage, calls, own, kp, peer, recipientBox, send } = await sendingEngine(t, { stamps: 6 })
  const puts = () => calls.filter((c) => c[0] === 'put').length
  const sent = await send()
  t.is(puts(), 2)
  t.is(await wallet(storage), 4, 'one text message: two stamps')
  const target = { from: own, id: sent.id }
  const react = (emoji, tg = target) => engine.react(own, kp, { to: peer, target: tg, emoji }, recipientBox)

  t.alike(await react('\u{1f44d}'), { ok: true })
  t.is(puts(), 4, 'the same two drops as a message: peer copy and self copy')
  t.is(await wallet(storage), 2, 'the same two stamps as a message')
  let row = (await engine.thread(own, { peer })).messages[0]
  t.alike(row.reactions, [{ emoji: '\u{1f44d}', mine: true }])
  t.alike(Object.keys(row).sort(), ['at', 'card', 'from', 'fwd', 'id', 'media', 'mine', 'reactions', 'replyTo', 'text'])

  t.alike(await react('\u{1f44d}'), { ok: true }, 'the same emoji again')
  t.is(puts(), 4, 'a no-op puts nothing')
  t.is(await wallet(storage), 2, 'a no-op spends nothing')

  t.is((await errorOf(react('\u{1f44d}', { from: own, id: '00'.repeat(16) }))).message, 'mensagem não encontrada')
  t.is((await errorOf(react('\u{1f44d}', { from: peer, id: sent.id }))).message, 'mensagem não encontrada', 'by sender and id')

  t.alike(await react(''), { ok: true }, 'a removal is sent')
  t.is(puts(), 6)
  t.is(await wallet(storage), 0)
  row = (await engine.thread(own, { peer })).messages[0]
  t.absent('reactions' in row, 'no key when empty')
  t.alike(await react(''), { ok: true }, 'removing nothing is a no-op')
  t.is(puts(), 6)

  const err = await errorOf(react('❤️'))
  t.is(err && err.message, 'o limite de envio de hoje acabou', 'the dm.send refusal')
  t.absent(err && err.uncertain, 'nothing went out')
  t.is(puts(), 6)
  const sendErr = await errorOf(send())
  t.is(sendErr && sendErr.message, err.message, 'one daily allowance for both')
})

test('dm.react: a row stored without a digest takes no reaction, spends nothing, and dm.thread marks it reactable: false', async (t) => {
  let local = null
  const { engine, storage, calls, own, kp, peer, recipientBox, send } = await sendingEngine(t, {
    stamps: 4,
    options: { createStore: (o) => (local = createDmStore(o)) }
  })
  const puts = () => calls.filter((c) => c[0] === 'put').length
  const sent = await send()
  // The shape a build without digests filed: a message with no digest.
  const old = { t: 'msg', id: '77'.repeat(16), peer, from: peer, text: 'de antes', replyTo: null, at: '2026-11-03T09:00:00.000Z', mine: false, filedAt: local.nextFiled() }
  await local.append([old])
  t.is(puts(), 2)
  t.is(await wallet(storage), 2)

  const err = await errorOf(engine.react(own, kp, { to: peer, target: { from: peer, id: old.id }, emoji: '\u{1f44d}' }, recipientBox))
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, 'esta mensagem não aceita reações')
  t.absent(err && err.uncertain, 'nothing went out')
  t.is(puts(), 2, 'no put')
  t.is(await wallet(storage), 2, 'no stamp')

  const rows = (await engine.thread(own, { peer })).messages
  const oldRow = rows.find((m) => m.id === old.id)
  t.is(oldRow.reactable, false)
  t.absent('reactions' in oldRow)
  t.absent('reactable' in rows.find((m) => m.id === sent.id), 'absent on a row that takes reactions')
})

test('dm.react: the self copy fails after the peer copy; a second call resumes it without new stamps', async (t) => {
  const { engine, storage, link, own, kp, peer, recipientBox, send } = await sendingEngine(t, { stamps: 4 })
  const sent = await send()
  const target = { from: own, id: sent.id }
  const react = (emoji) => engine.react(own, kp, { to: peer, target, emoji }, recipientBox)
  const put = link.put
  const putBytes = []
  link.put = async (bytes) => {
    putBytes.push(bytes)
    if (putBytes.length === 2) throw new Error('lost ack')
    return put(bytes)
  }
  const err = await errorOf(react('\u{1f44d}'))
  t.is(err && err.message, 'não deu para confirmar o envio', 'the dm.send answer')
  t.is(err && err.uncertain, true)
  t.is(await wallet(storage), 0, 'two stamps spent')
  t.alike((await engine.thread(own, { peer })).messages[0].reactions, [{ emoji: '\u{1f44d}', mine: true }], 'filed once the peer copy was acked')
  await engine.idle()
  t.is(putBytes.length, 2, 'never put again on its own')

  t.alike(await react('\u{1f44d}'), { ok: true }, 'the pending entry beats the no-op rule')
  t.is(putBytes.length, 3, 'only the self copy is put')
  t.ok(b4a.equals(putBytes[1], putBytes[2]), 'the same bytes')
  t.is(await wallet(storage), 0, 'no new stamps (none left to spend)')
  t.alike(await react('\u{1f44d}'), { ok: true })
  t.is(putBytes.length, 3, 'delivered: a no-op from then on')
  t.is((await engine.thread(own, { peer })).messages[0].reactions.length, 1)
})

test('dm.react between two nodes: one pull files a reaction and a message, peers converge on replace and remove, the second device shows its own', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await copyDiary(B, A)
  const first = await B.web.request('dm.send', { to: A.key, text: 'primeira' })
  t.is((await A.web.request('dm.pull')).added, 1)
  await A.web.request('dm.seen', { peer: B.key })
  const target = { from: B.key, id: first.id }
  const listOf = async (n) => (await n.web.request('dm.list', { folder: 'request' })).conversations.concat((await n.web.request('dm.list', {})).conversations)
  const before = await listOf(A)

  // A reaction and a message in one pull page: both filed, the cursor moves.
  const puts = seeder.puts.length
  t.alike(await B.web.request('dm.react', { to: A.key, target, emoji: '\u{1f44d}' }), { ok: true })
  t.is(seeder.puts.length, puts + 2, 'peer copy and self copy')
  const second = await B.web.request('dm.send', { to: A.key, text: 'segunda' })
  const cursor = await store.readDmCursor(A.storage)
  t.is((await A.web.request('dm.pull')).added, 1, 'the message counts, the reaction does not')
  t.not(await store.readDmCursor(A.storage), cursor, 'the cursor moved past both')
  t.is((await A.web.request('dm.pull')).added, 0, 'a second pull is clean')
  let rows = (await A.web.request('dm.thread', { peer: B.key })).messages
  t.alike(rows.map((m) => m.id), [first.id, second.id])
  t.alike(rows[0].reactions, [{ emoji: '\u{1f44d}', mine: false }])
  t.absent('reactions' in rows[1])
  await A.web.request('dm.seen', { peer: B.key })

  // A reacts too, then B replaces and removes; both sides agree each time.
  t.alike(await A.web.request('dm.react', { to: B.key, target, emoji: '\u2764\ufe0f' }), { ok: true })
  await B.web.request('dm.pull')
  t.alike((await B.web.request('dm.thread', { peer: A.key })).messages[0].reactions, [{ emoji: '\u2764\ufe0f', mine: false }, { emoji: '\u{1f44d}', mine: true }])
  await B.web.request('dm.react', { to: A.key, target, emoji: '\u{1f602}' })
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { peer: B.key })).messages[0].reactions, [{ emoji: '\u{1f602}', mine: false }, { emoji: '\u2764\ufe0f', mine: true }], 'replaced')
  await B.web.request('dm.react', { to: A.key, target, emoji: '' })
  await A.web.request('dm.pull')
  rows = (await A.web.request('dm.thread', { peer: B.key })).messages
  t.alike(rows[0].reactions, [{ emoji: '\u2764\ufe0f', mine: true }], 'removed')
  t.alike((await B.web.request('dm.thread', { peer: A.key })).messages[0].reactions, [{ emoji: '\u2764\ufe0f', mine: false }], 'the same on both sides')

  // Unread and the list preview never move for a reaction.
  const after = await listOf(A)
  t.alike(after.map((c) => [c.peer, c.preview, c.unread]), [[B.key, 'segunda', false]])
  t.is(before[0].unread, false)

  // B's second device: its own reaction arrives through the self copy.
  const B2 = await memberNode(t, assoc, seeder.url, { keyPair: B.keyPair, prf: B.prf, enable: false })
  await B2.web.request('dm.pull')
  t.alike((await B2.web.request('dm.thread', { peer: A.key })).messages[0].reactions, [{ emoji: '\u2764\ufe0f', mine: false }])
  await B.web.request('dm.react', { to: A.key, target, emoji: '\u{1f525}' })
  await B2.web.request('dm.pull')
  t.alike((await B2.web.request('dm.thread', { peer: A.key })).messages[0].reactions, [{ emoji: '\u2764\ufe0f', mine: false }, { emoji: '\u{1f525}', mine: true }], 'own reaction on the other device')
})

test('dm.react: two devices of one passkey racing on the same rev converge, and the next op wins everywhere', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await copyDiary(B, A)
  const first = await A.web.request('dm.send', { to: B.key, text: 'primeira' })
  const B2 = await memberNode(t, assoc, seeder.url, { keyPair: B.keyPair, prf: B.prf, enable: false })
  // The second device takes half of B's stamps (sealed under the passkey's
  // local key, so they open on both) and B's enabled key generation, as a
  // device that has read B's diary would: this one never enabled.
  await store.writeDmKey(B2.storage, (await store.readDmKey(B.storage)).gen)
  await copyDiary(A, B2)
  const w = await store.readDmStamps(B.storage)
  const half = Math.floor(w.items.length / 2)
  await store.writeDmStamps(B2.storage, { items: w.items.slice(0, half), kids: w.kids })
  await store.writeDmStamps(B.storage, { items: w.items.slice(half), kids: w.kids })
  await B.web.request('dm.pull')
  await B2.web.request('dm.pull')
  const target = { from: A.key, id: first.id }
  const mine = async (n, peer) => (await n.web.request('dm.thread', { peer })).messages[0].reactions
  // Neither device has seen the other's op: both sign rev 1.
  await B.web.request('dm.react', { to: A.key, target, emoji: '\u{1f44d}' })
  await B2.web.request('dm.react', { to: A.key, target, emoji: '\u2764\ufe0f' })
  for (const n of [A, B, B2]) await n.web.request('dm.pull')
  const onA = await mine(A, B.key)
  t.is(onA.length, 1, 'one reaction per person')
  t.ok(['\u{1f44d}', '\u2764\ufe0f'].includes(onA[0].emoji))
  t.alike(await mine(B, A.key), [{ emoji: onA[0].emoji, mine: true }], 'the tie goes to the same op on every device')
  t.alike(await mine(B2, A.key), [{ emoji: onA[0].emoji, mine: true }])
  // A device that has filed the other's op picks a rev past both.
  await B2.web.request('dm.react', { to: A.key, target, emoji: '\u{1f602}' })
  for (const n of [A, B]) await n.web.request('dm.pull')
  t.alike(await mine(A, B.key), [{ emoji: '\u{1f602}', mine: false }], 'the newer op wins on the peer')
  t.alike(await mine(B, A.key), [{ emoji: '\u{1f602}', mine: true }], 'and on the racing device')
  t.alike(await mine(B2, A.key), [{ emoji: '\u{1f602}', mine: true }])
})

test('dm.react between two nodes: the reaction names the message digest both sides store; a message reusing the id on a device without the history does not show it', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await copyDiary(B, A)
  const boxA = await dmBoxKeyPairFromPrf(A.prf, 1)
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  const open = (bytes, pair, self) => dmCore.openInner(dmCore.openSealed(dmCore.decodeDrop(bytes).sealed, pair), self, { association: hex(assoc.publicKey) })

  const before = seeder.pool.entries.length
  const first = await B.web.request('dm.send', { to: A.key, text: 'primeira' })
  const msgEntries = seeder.pool.entries.slice(before)
  t.is(msgEntries.length, 2, 'peer copy and self copy')
  const received = open(msgEntries[0].bytes, boxA, A.key)
  t.is(received.text, 'primeira')
  const sent = dmCore.bodyDigest(received)
  t.ok(/^[0-9a-f]{64}$/.test(sent))
  t.is(dmCore.bodyDigest(open(msgEntries[1].bytes, boxB, B.key)), sent, 'the self copy names the same digest')
  t.is((await A.web.request('dm.pull')).added, 1)
  await A.web.request('dm.seen', { peer: B.key })

  const target = { from: B.key, id: first.id }
  const rxAt = seeder.pool.entries.length
  t.alike(await A.web.request('dm.react', { to: B.key, target, emoji: '\u{1f44d}' }), { ok: true })
  const rxEntries = seeder.pool.entries.slice(rxAt)
  const rx = open(rxEntries[0].bytes, boxB, B.key)
  t.is(rx.kind, 'react')
  t.alike(rx.target, { from: B.key, id: first.id, digest: sent }, 'the receiver stored the digest the sender signed, and the reaction names it')
  t.absent('digest' in (await A.web.request('dm.thread', { peer: B.key })).messages[0], 'dm.thread does not return the digest')
  await B.web.request('dm.pull')
  t.alike((await B.web.request('dm.thread', { peer: A.key })).messages[0].reactions, [{ emoji: '\u{1f44d}', mine: false }], 'shown on the sender, whose row has the same digest')
  t.alike((await A.web.request('dm.thread', { peer: B.key })).messages[0].reactions, [{ emoji: '\u{1f44d}', mine: true }])

  // B, with a modified client, signs another message under the same id. The
  // original drops are gone from the pool (past retention), so A's new
  // device files the new message and A's own signed reaction.
  const key = await dmLocalKeyFromPrf(B.prf)
  const w = await store.readDmStamps(B.storage)
  const stamp = { kid: w.items[0].kid, ...gc.openRecord({ nonce: w.items[0].nonce, box: w.items[0].box }, key) }
  await store.writeDmStamps(B.storage, { items: w.items.slice(1), kids: w.kids })
  const reused = dmCore.buildInner({ kind: 'msg', id: first.id, to: A.key, text: 'trocada', cert: createCert({ member: B.key }, assoc) }, B.keyPair)
  const drop = dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: b4a.from(stamp.kid, 'hex'), rsaSig: b4a.from(stamp.sig, 'base64'), token: b4a.from(stamp.token, 'hex'), sealed: dmCore.sealInner(reused, hex(boxA.publicKey)) })
  t.ok(seeder.pool.submit(drop), 'the pool takes the drop')
  for (const e of msgEntries) seeder.pool.entries.splice(seeder.pool.entries.indexOf(e), 1)

  const A2 = await memberNode(t, assoc, seeder.url, { keyPair: A.keyPair, prf: A.prf, enable: false })
  await A2.web.request('dm.pull')
  const rows = (await A2.web.request('dm.thread', { peer: B.key })).messages
  t.alike(rows.map((m) => [m.id, m.text]), [[first.id, 'trocada']], 'the new device files the message under the reused id')
  t.absent('reactions' in rows[0], 'the reaction made for the other message is not shown on it')
  t.alike((await A.web.request('dm.thread', { peer: B.key })).messages[0].reactions, [{ emoji: '\u{1f44d}', mine: true }], 'the device with the history keeps it on the original')
})

test('dm.send: a reply to a row with a digest signs and stores { from, id, digest }; a row without one is quoted by its bare id; a stored binding to another digest reads replyMissing', async (t) => {
  let local = null
  const { engine, prf, link, own, association, kp, peer, recipientBox, send } = await sendingEngine(t, {
    stamps: 6,
    options: { createStore: (o) => (local = createDmStore(o)) }
  })
  const put = link.put
  const putBytes = []
  link.put = async (bytes) => {
    putBytes.push(bytes)
    return put(bytes)
  }
  const ownBox = await dmBoxKeyPairFromPrf(prf, 1)
  const selfCopy = () => dmCore.openInner(dmCore.openSealed(dmCore.decodeDrop(putBytes[putBytes.length - 1]).sealed, ownBox), own, { association })
  const storedRow = (id) => local.snapshot().messages.find((m) => m.id === id)

  const sent = await send()
  const digest = storedRow(sent.id).digest
  t.ok(/^[0-9a-f]{64}$/.test(digest), 'the quoted row has a digest')
  const reply = await engine.send(own, kp, { to: peer, text: 'resposta', replyTo: sent.id }, recipientBox)
  const inner = selfCopy()
  t.is(inner.v, 2, 'a bound reply is an inner v2')
  t.alike(inner.replyTo, { from: own, id: sent.id, digest }, 'signed bound to the quoted sender, id and digest')
  const stored = storedRow(reply.id)
  t.alike([stored.replyTo, stored.replyFrom, stored.replyDigest], [sent.id, own, digest], 'stored as the bare id beside the binding')

  // The shape a build without digests filed: quoted by its bare id, as before.
  const old = { t: 'msg', id: '77'.repeat(16), peer, from: peer, text: 'de antes', replyTo: null, at: '2026-11-03T09:00:00.000Z', mine: false, filedAt: local.nextFiled() }
  await local.append([old])
  const bare = await engine.send(own, kp, { to: peer, text: 'sobre aquela', replyTo: old.id }, recipientBox)
  t.is(selfCopy().v, 1, 'a bare reply to a text keeps inner v1')
  t.is(selfCopy().replyTo, old.id)
  t.absent('replyFrom' in storedRow(bare.id) || 'replyDigest' in storedRow(bare.id))

  // A binding that names another digest under the same sender and id.
  const other = { t: 'msg', id: '88'.repeat(16), peer, from: peer, text: 'outra', replyTo: sent.id, replyFrom: own, replyDigest: 'e0'.repeat(32), at: '2026-11-03T09:30:00.000Z', mine: false, filedAt: local.nextFiled() }
  await local.append([other])

  const rows = (await engine.thread(own, { peer })).messages
  const row = (id) => rows.find((m) => m.id === id)
  t.is(row(reply.id).replyTo, sent.id)
  t.is(row(reply.id).replyFrom, own, 'the quoted row is kept here')
  t.absent('replyMissing' in row(reply.id))
  t.absent('replyDigest' in row(reply.id) || 'digest' in row(reply.id), 'dm.thread hands out no digest')
  t.is(row(bare.id).replyTo, old.id)
  t.absent('replyFrom' in row(bare.id) || 'replyMissing' in row(bare.id), 'a bare reply carries neither')
  t.is(row(other.id).replyTo, sent.id)
  t.is(row(other.id).replyMissing, true, 'another digest: the message it quoted is not on this device')
  t.absent('replyFrom' in row(other.id))
})

test('dm.send between two nodes: a bound reply quotes the message both sides store; a message reusing the id on a device without the history leaves the reply without a quote', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await copyDiary(B, A)
  const boxA = await dmBoxKeyPairFromPrf(A.prf, 1)
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  const open = (bytes, pair, self) => dmCore.openInner(dmCore.openSealed(dmCore.decodeDrop(bytes).sealed, pair), self, { association: hex(assoc.publicKey) })

  const before = seeder.pool.entries.length
  const first = await B.web.request('dm.send', { to: A.key, text: 'primeira' })
  const msgEntries = seeder.pool.entries.slice(before)
  const sent = dmCore.bodyDigest(open(msgEntries[0].bytes, boxA, A.key))
  t.is((await A.web.request('dm.pull')).added, 1)

  const replyAt = seeder.pool.entries.length
  const reply = await A.web.request('dm.send', { to: B.key, text: 'respondendo', replyTo: first.id })
  const replyEntries = seeder.pool.entries.slice(replyAt)
  t.is(replyEntries.length, 2, 'peer copy and self copy')
  const rx = open(replyEntries[0].bytes, boxB, B.key)
  t.is(rx.v, 2)
  t.alike(rx.replyTo, { from: B.key, id: first.id, digest: sent }, 'the reply names the digest the sender signed')
  t.alike(open(replyEntries[1].bytes, boxA, A.key).replyTo, rx.replyTo, 'the self copy names the same')

  await B.web.request('dm.pull')
  const onB = (await B.web.request('dm.thread', { peer: A.key })).messages
  t.alike(onB.map((m) => [m.id, m.replyTo, m.replyFrom, m.replyMissing]), [[first.id, null, undefined, undefined], [reply.id, first.id, B.key, undefined]], 'the sender shows the quote')
  const onA = (await A.web.request('dm.thread', { peer: B.key })).messages
  t.is(onA[1].replyFrom, B.key)

  // B, with a modified client, signs another message under the same id. The
  // original drops are gone from the pool (past retention), so A's new
  // device files the new message and A's own signed reply.
  const key = await dmLocalKeyFromPrf(B.prf)
  const w = await store.readDmStamps(B.storage)
  const stamp = { kid: w.items[0].kid, ...gc.openRecord({ nonce: w.items[0].nonce, box: w.items[0].box }, key) }
  await store.writeDmStamps(B.storage, { items: w.items.slice(1), kids: w.kids })
  const reused = dmCore.buildInner({ kind: 'msg', id: first.id, to: A.key, text: 'trocada', cert: createCert({ member: B.key }, assoc) }, B.keyPair)
  const drop = dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: b4a.from(stamp.kid, 'hex'), rsaSig: b4a.from(stamp.sig, 'base64'), token: b4a.from(stamp.token, 'hex'), sealed: dmCore.sealInner(reused, hex(boxA.publicKey)) })
  t.ok(seeder.pool.submit(drop), 'the pool takes the drop')
  for (const e of msgEntries) seeder.pool.entries.splice(seeder.pool.entries.indexOf(e), 1)

  const A2 = await memberNode(t, assoc, seeder.url, { keyPair: A.keyPair, prf: A.prf, enable: false })
  await A2.web.request('dm.pull')
  const rows = (await A2.web.request('dm.thread', { peer: B.key })).messages
  const quoted = rows.find((m) => m.id === first.id)
  t.is(quoted && quoted.text, 'trocada', 'the new device files the message under the reused id')
  const r2 = rows.find((m) => m.id === reply.id)
  t.ok(r2, 'the reply is filed')
  t.is(r2.replyTo, first.id)
  t.is(r2.replyMissing, true, 'the reply is not shown quoting the other message')
  t.absent('replyFrom' in r2)
  t.is((await A.web.request('dm.thread', { peer: B.key })).messages[1].replyFrom, B.key, 'the device with the history keeps the quote')
})

const PAGE_AT = '2026-11-03T12:00:00.000Z'
const PAGE_NONCE = 'r'.repeat(43)

test('a reaction drop to a Página is dropped, never filed, and the pull goes on past it', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc)
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const pageCert = createCert({ member: P }, assoc)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: hex((await dmBoxKeyPairFromPrf(A.prf, 1)).publicKey) }] })
  const m = await createMember({ storage: memoryStorage(), association: hex(assoc.publicKey), keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(pageCert)
  const fields = { page: P, gen: 1, owner: A.key, admins: [], prev: null, at: PAGE_AT, nonce: PAGE_NONCE, association: hex(assoc.publicKey) }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, A.keyPair) }, issuerKp, issuerCert))
  await m.core.append({ type: 'dm-key', box: made.box, gen: 1, at: PAGE_AT })
  for (const n of [A, C]) await holdCore(m.core, n.storage)
  const self = made.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: self.sealed, by: A.key, sig: self.sig, box: made.box, groupBox: made.groupBox, cert: pageCert })
  await copyDiary(C, A)

  const draft = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'da página' })
  const expiresAt = Date.now() + dmCore.DM_V3_TTL_MS
  await A.web.request('dm.pageSend', { page: P, id: draft.id, signature: dmCore.signDigest(draft.digest, pageKp.secretKey, expiresAt), expiresAt })
  await C.web.request('dm.pull')
  t.alike((await C.web.request('dm.thread', { peer: P })).messages.map((x) => x.text), ['da página'])

  // C holds the Página's diary: the node refuses, before anything is spent.
  const wallet0 = (await store.readDmStamps(C.storage)).items.length
  const refused = await errorOf(C.web.request('dm.react', { to: P, target: { from: P, id: draft.id }, emoji: '\u{1f44d}' }))
  t.is(refused && refused.message, 'conversas com uma Página não têm reações')
  t.absent(refused && refused.uncertain, 'nothing was sent')
  t.is((await store.readDmStamps(C.storage)).items.length, wallet0, 'no stamp spent')
  // A node without that diary cannot tell: a reaction drop it would send is
  // put by hand here, with one of C's stamps.
  const key = await dmLocalKeyFromPrf(C.prf)
  const w = await store.readDmStamps(C.storage)
  const stamp = { kid: w.items[0].kid, ...gc.openRecord({ nonce: w.items[0].nonce, box: w.items[0].box }, key) }
  await store.writeDmStamps(C.storage, { items: w.items.slice(1), kids: w.kids })
  const rx = dmCore.buildInner({ kind: 'react', id: dmCore.newMessageId(), at: new Date().toISOString(), to: P, target: { from: P, id: draft.id, digest: 'ab'.repeat(32) }, emoji: '\u{1f44d}', rev: 1, cert: createCert({ member: C.key }, assoc) }, C.keyPair)
  t.ok(seeder.pool.submit(dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: b4a.from(stamp.kid, 'hex'), rsaSig: b4a.from(stamp.sig, 'base64'), token: b4a.from(stamp.token, 'hex'), sealed: dmCore.sealInner(rx, made.box) })), 'the pool takes the reaction drop')
  await C.web.request('dm.send', { to: P, text: 'depois da reação' })
  await A.web.request('dm.pull')
  const rows = (await A.web.request('dm.thread', { page: P, peer: C.key })).messages
  t.alike(rows.map((x) => x.text), ['da página', 'depois da reação'], 'the message after it is filed')
  t.absent(rows.some((x) => 'reactions' in x), 'no reaction in a Página conversation')
  t.is((await A.web.request('dm.pull')).added, 0, 'a second pull is clean')
})

async function holdCore (core, storage) {
  const dst = await store.openReplica(storage, b4a.toString(core.key, 'hex'))
  const a = core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    await dst.download({ start: 0, end: core.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
}

test('dm.react: a removal after a lost peer ack is sent, never taken as a no-op', async (t) => {
  const { engine, storage, link, own, kp, peer, recipientBox, send } = await sendingEngine(t, { stamps: 6 })
  const sent = await send()
  const target = { from: own, id: sent.id }
  const react = (emoji) => engine.react(own, kp, { to: peer, target, emoji }, recipientBox)
  link.failPut = true
  const err = await errorOf(react('\u{1f44d}'))
  t.is(err && err.uncertain, true, 'the peer may hold it')
  t.absent('reactions' in (await engine.thread(own, { peer })).messages[0], 'nothing filed here')
  link.failPut = false
  const before = await wallet(storage)
  t.alike(await react(''), { ok: true })
  t.is(await wallet(storage), before - 2, 'a removal went out')
  t.absent('reactions' in (await engine.thread(own, { peer })).messages[0])
})

test('dm.react: going back to an emoji whose op is still pending makes a newer op', async (t) => {
  const { engine, storage, link, own, kp, peer, recipientBox, send } = await sendingEngine(t, { stamps: 8 })
  const sent = await send()
  const target = { from: own, id: sent.id }
  const react = (emoji) => engine.react(own, kp, { to: peer, target, emoji }, recipientBox)
  const put = link.put
  let n = 0
  link.put = async (bytes) => {
    if (++n === 2) throw new Error('lost ack')
    return put(bytes)
  }
  t.is((await errorOf(react('\u{1f44d}'))).uncertain, true, 'self copy unacked')
  t.alike(await react('\u2764\ufe0f'), { ok: true })
  t.alike((await engine.thread(own, { peer })).messages[0].reactions, [{ emoji: '\u2764\ufe0f', mine: true }])
  const before = await wallet(storage)
  t.alike(await react('\u{1f44d}'), { ok: true })
  t.is(await wallet(storage), before - 2, 'a new op, not the old one resumed')
  t.alike((await engine.thread(own, { peer })).messages[0].reactions, [{ emoji: '\u{1f44d}', mine: true }], 'the newest rev wins')
})

const reactPending = async (storage) => ((await storage.readJson('dmReactPending')) || { items: [] }).items

// Replaces the wallet with n fresh stamps sealed under the engine's local key.
async function refill (s, n) {
  const sealer = await opener(s.prf)
  const kid = 'ab'.repeat(8)
  await store.writeDmStamps(s.storage, { kids: [kid], items: Array.from({ length: n }, () => ({ kid, ...sealer.seal({ token: hex(crypto.randomBytes(32)), sig: b4a.toString(b4a.alloc(dmCore.DROP.SIG_BYTES), 'base64') }) })) })
}

// A new engine on the same storage and link (a reload), unlocked again.
async function reloaded (t, s) {
  await s.engine.close()
  const engine = engineWithDmLink(s.link)({ storage: s.storage, association: s.association, emit: (name, data) => s.calls.push([name, data]) })
  t.teardown(() => engine.close(), { force: true })
  await engine.unlock(s.prf)
  await engine.loaded()
  return engine
}

test('dm.react: an op whose link did not open survives a reload, sealed, and goes out once on the user retry with no new stamp', async (t) => {
  const s = await sendingEngine(t, { stamps: 4 })
  const { storage, link, own, kp, peer, recipientBox } = s
  const puts = () => s.calls.filter((c) => c[0] === 'put').length
  const sent = await s.send()
  const target = { from: own, id: sent.id }
  const react = (engine, emoji) => engine.react(own, kp, { to: peer, target, emoji }, recipientBox)
  link.offline = true
  const err = await errorOf(react(s.engine, '\u{1f44d}'))
  t.is(err && err.message, 'sem conexão com o semeador')
  t.is(puts(), 2, 'nothing put')
  t.is(await wallet(storage), 0, 'its two stamps are in the op')
  const items = await reactPending(storage)
  t.is(items.length, 1, 'stored')
  t.absent(JSON.stringify(items).includes(sent.id), 'no target in clear')
  t.absent(JSON.stringify(items).includes(peer), 'no peer in clear')
  const stranger = await opener(crypto.randomBytes(32))
  t.ok(items.length === 1 && stranger.open(items[0].meta) === null, 'another local key cannot open it')

  const engine = await reloaded(t, s)
  link.offline = false
  await engine.idle()
  t.is(puts(), 2, 'never put on its own after the reload')
  t.alike(await react(engine, '\u{1f44d}'), { ok: true }, 'the user retry')
  t.is(puts(), 4, 'its two drops, once')
  t.is(await wallet(storage), 0, 'no new stamp (none left to spend)')
  t.alike((await engine.thread(own, { peer })).messages[0].reactions, [{ emoji: '\u{1f44d}', mine: true }])
  t.is(await storage.readJson('dmReactPending'), null, 'sent: gone from kv')
  t.alike(await react(engine, '\u{1f44d}'), { ok: true })
  t.is(puts(), 4, 'a no-op from then on')
})

test('dm.react: after a lost self-copy ack and a reload, only the user retry puts the self copy, with the same bytes', async (t) => {
  const s = await sendingEngine(t, { stamps: 4 })
  const sent = await s.send()
  const target = { from: s.own, id: sent.id }
  const react = (engine, emoji) => engine.react(s.own, s.kp, { to: s.peer, target, emoji }, s.recipientBox)
  const put = s.link.put
  const putBytes = []
  s.link.put = async (bytes) => {
    putBytes.push(bytes)
    if (putBytes.length === 2) throw new Error('lost ack')
    return put(bytes)
  }
  const err = await errorOf(react(s.engine, '\u{1f44d}'))
  t.is(err && err.uncertain, true)
  const engine = await reloaded(t, s)
  await engine.idle()
  t.is(putBytes.length, 2, 'not put again on its own')
  t.alike(await react(engine, '\u{1f44d}'), { ok: true }, 'the pending op beats the no-op rule after the reload')
  t.is(putBytes.length, 3, 'only the self copy')
  t.ok(b4a.equals(putBytes[1], putBytes[2]), 'the same bytes')
  t.is(await s.storage.readJson('dmReactPending'), null)
})

test('dm.react: a newer emoji before the reload replaces the stored op; the older one is gone', async (t) => {
  const s = await sendingEngine(t, { stamps: 6 })
  const puts = () => s.calls.filter((c) => c[0] === 'put').length
  const sent = await s.send()
  const target = { from: s.own, id: sent.id }
  const react = (engine, emoji) => engine.react(s.own, s.kp, { to: s.peer, target, emoji }, s.recipientBox)
  s.link.offline = true
  t.is((await errorOf(react(s.engine, '\u{1f44d}'))).message, 'sem conexão com o semeador')
  t.is((await errorOf(react(s.engine, '❤️'))).message, 'sem conexão com o semeador')
  t.is((await reactPending(s.storage)).length, 1, 'one op per message')
  const engine = await reloaded(t, s)
  s.link.offline = false
  t.alike(await react(engine, '❤️'), { ok: true })
  t.is(puts(), 4)
  t.alike((await engine.thread(s.own, { peer: s.peer })).messages[0].reactions, [{ emoji: '❤️', mine: true }])
  const err = await errorOf(react(engine, '\u{1f44d}'))
  t.is(err && err.message, 'o limite de envio de hoje acabou', 'the replaced op is not pending: a new op needs stamps')
  t.is(puts(), 4)
})

test('dm.react: a lock keeps the stored op sealed for the next unlock; a reset deletes it', async (t) => {
  const s = await sendingEngine(t, { stamps: 6 })
  const puts = () => s.calls.filter((c) => c[0] === 'put').length
  const sent = await s.send()
  const target = { from: s.own, id: sent.id }
  const react = (emoji) => s.engine.react(s.own, s.kp, { to: s.peer, target, emoji }, s.recipientBox)
  s.link.offline = true
  await errorOf(react('\u{1f44d}'))
  s.engine.lock()
  t.is((await reactPending(s.storage)).length, 1, 'kept, like the ctl queue')
  t.is((await errorOf(react('\u{1f44d}'))).message, LOCKED)
  await s.engine.unlock(s.prf)
  await s.engine.loaded()
  s.link.offline = false
  t.alike(await react('\u{1f44d}'), { ok: true })
  t.is(puts(), 4)
  t.is(await wallet(s.storage), 2, 'no new stamp')

  s.link.offline = true
  await errorOf(react('❤️'))
  t.is((await reactPending(s.storage)).length, 1)
  await s.engine.idle()
  await store.deleteDmData(s.storage)
  t.is(await s.storage.readJson('dmReactPending'), null, 'a reset deletes it')
})

test('dm.react: kv keeps at most 32 pending ops, dropping the oldest', async (t) => {
  let local = null
  // The wallet holds at most 64 stamps: 32 ops, then a refill for the 33rd.
  const s = await sendingEngine(t, { stamps: 64, options: { createStore: (o) => (local = createDmStore(o)) } })
  const ids = []
  for (let i = 0; i < 33; i++) {
    const id = i.toString(16).padStart(32, '0')
    ids.push(id)
    await local.append([{ t: 'msg', id, peer: s.peer, from: s.peer, text: 'm' + i, replyTo: null, at: '2026-11-03T09:00:00.000Z', mine: false, digest: hex(crypto.randomBytes(32)), filedAt: local.nextFiled() }])
  }
  const react = (engine, id) => engine.react(s.own, s.kp, { to: s.peer, target: { from: s.peer, id }, emoji: '\u{1f44d}' }, s.recipientBox)
  s.link.offline = true
  for (const id of ids) {
    if (id === ids[32]) await refill(s, 2)
    t.is((await errorOf(react(s.engine, id))).message, 'sem conexão com o semeador')
  }
  t.is(await wallet(s.storage), 0)
  t.is((await reactPending(s.storage)).length, 32)
  const engine = await reloaded(t, s)
  s.link.offline = false
  t.is((await errorOf(react(engine, ids[0]))).message, 'o limite de envio de hoje acabou', 'the oldest was dropped')
  t.alike(await react(engine, ids[32]), { ok: true }, 'the newest is still pending')
  t.alike(await react(engine, ids[1]), { ok: true }, 'the second oldest too')
})

test('dm.react: a restore after a lock waits for a save still writing, so the last change before the lock is kept', async (t) => {
  const s = await sendingEngine(t, { stamps: 6 })
  const puts = () => s.calls.filter((c) => c[0] === 'put').length
  const sent = await s.send()
  const target = { from: s.own, id: sent.id }
  const react = (emoji) => s.engine.react(s.own, s.kp, { to: s.peer, target, emoji }, s.recipientBox)
  s.link.offline = true
  t.is((await errorOf(react('\u{1f44d}'))).message, 'sem conexão com o semeador')
  const writeJson = s.storage.writeJson
  let release = null
  s.storage.writeJson = async (key, value) => {
    if (key === 'dmReactPending' && release === null) await new Promise((resolve) => { release = resolve })
    return writeJson.call(s.storage, key, value)
  }
  const first = errorOf(react('❤️'))
  await until(() => release !== null)
  s.engine.lock()
  await s.engine.unlock(s.prf)
  await s.engine.loaded()
  const retry = errorOf(react('❤️'))
  // Event-loop turns, not time: without the wait the restore reads kv here.
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
  release()
  const err = await retry
  t.is(err && err.message, 'sem conexão com o semeador', 'the retry resumes the newest op, no new one')
  await first
  s.link.offline = false
  t.alike(await react('❤️'), { ok: true })
  t.is(puts(), 4, 'its two drops, once')
  t.is(await wallet(s.storage), 0, 'no new stamp')
  t.alike((await s.engine.thread(s.own, { peer: s.peer })).messages[0].reactions, [{ emoji: '❤️', mine: true }])
})

test('dm.react: stored ops are merged into a list already holding 32 pending sends, not dropped by the restore', async (t) => {
  const s = await sendingEngine(t, { stamps: 4 })
  const puts = () => s.calls.filter((c) => c[0] === 'put').length
  const sent = await s.send()
  const target = { from: s.own, id: sent.id }
  const react = (engine, emoji) => engine.react(s.own, s.kp, { to: s.peer, target, emoji }, s.recipientBox)
  s.link.offline = true
  t.is((await errorOf(react(s.engine, '\u{1f44d}'))).message, 'sem conexão com o semeador')
  const engine = await reloaded(t, s)
  await refill(s, 64)
  for (let i = 0; i < 32; i++) {
    const err = await errorOf(engine.send(s.own, s.kp, { to: s.peer, text: 'p' + i }, s.recipientBox))
    t.is(err && err.message, 'sem conexão com o semeador')
  }
  t.is(await wallet(s.storage), 0, '32 pending sends hold every stamp')
  s.link.offline = false
  const err = await errorOf(react(engine, '\u{1f44d}'))
  t.is(err, null, 'the stored op is still pending')
  t.is(puts(), 4, 'its two drops, once')
  t.is((await reactPending(s.storage)).length, 0)
})

// ---- visitas (the engine over a fake visit lane) ----

const visitsCore = require('@varanda/core/lib/visits')

// A fake visit pool shared by engines: put files the bytes, page reads them.
function visitPool () {
  const pool = {
    entries: [],
    puts: 0,
    unsupported: false,
    failPut: false,
    refuse: null,
    dmPuts: 0,
    link () {
      return {
        async put (bytes) {
          pool.puts++
          if (pool.failPut) throw new Error('lost ack')
          if (pool.refuse !== null) return { ok: false, reason: pool.refuse }
          pool.entries.push({ seq: pool.entries.length + 1, bytes: b4a.from(bytes) })
          return { ok: true, reason: null }
        },
        async page ({ after, limit }) {
          const rest = pool.entries.filter((e) => e.seq > after)
          const items = rest.slice(0, limit)
          return { items, next: rest.length > items.length ? items[items.length - 1].seq : null }
        },
        close: noop
      }
    }
  }
  return pool
}

// createDmEngine with openVisitLink served by `pool` and openDmLink
// counting (a visit must never ride the dm channel).
function engineWithVisitPool (pool) {
  const transport = require('../lib/dm-link')
  const originalVisit = transport.openVisitLink
  const originalDm = transport.openDmLink
  const id = require.resolve('../lib/dm')
  const cached = require.cache[id]
  try {
    transport.openVisitLink = async () => {
      if (pool.unsupported) {
        const err = new Error('semeador sem visitas')
        err.unsupported = true
        throw err
      }
      return pool.link()
    }
    transport.openDmLink = async () => ({
      async put () { pool.dmPuts++; return { ok: true, reason: null } },
      async page () { return { items: [], next: null } },
      close: noop
    })
    delete require.cache[id]
    return require('../lib/dm').createDmEngine
  } finally {
    transport.openVisitLink = originalVisit
    transport.openDmLink = originalDm
    require.cache[id] = cached
  }
}

async function visitEngine (t, pool, assoc, { stamps = 8, limits = {}, visitsDue, identity, certified = true, kp = crypto.keyPair() } = {}) {
  const storage = memoryNodeStorage()
  const prf = crypto.randomBytes(32)
  const engine = engineWithVisitPool(pool)({
    storage,
    association: hex(assoc.publicKey),
    limits: { visitDelay: () => 0, ...limits },
    visitsDue,
    identity
  })
  t.teardown(() => engine.close(), { force: true })
  if (certified) await certify(storage, kp, assoc)
  await engine.unlock(prf)
  await engine.loaded()
  const local = await opener(prf)
  const kid = 'ab'.repeat(8)
  await store.writeDmStamps(storage, {
    kids: [kid],
    items: Array.from({ length: stamps }, () => ({
      kid,
      ...local.seal({ token: hex(crypto.randomBytes(32)), sig: b4a.toString(b4a.alloc(dmCore.DROP.SIG_BYTES), 'base64') })
    }))
  })
  return { engine, storage, kp, own: hex(kp.publicKey), box: engine.boxHex().box }
}

// A ping from `from` to `to` built by hand (a replay, an old day).
function handPing (from, to, assoc, day) {
  const cert = createCert({ member: from.own }, assoc)
  const inner = dmCore.buildInner({ kind: dmCore.DM_VISIT_KIND, to: to.own, day, cert }, from.kp)
  const sealed = dmCore.sealInner(inner, to.box)
  return dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: b4a.alloc(8), rsaSig: b4a.alloc(dmCore.DROP.SIG_BYTES), token: crypto.randomBytes(32), sealed })
}

test('visitas: a queued ping goes out on the visit lane with one stamp and no self copy, and files once for the recipient', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc)
  const B = await visitEngine(t, pool, assoc)
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: A.own, box: A.box, now }), { queued: false }, 'never to self')
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  await until(() => pool.puts === 1)
  await A.engine.idle()
  t.is(pool.entries.length, 1, 'one put: no self copy')
  t.is(pool.dmPuts, 0, 'nothing on the dm channel')
  t.is(await A.engine.walletSize(), 7, 'one stamp spent')
  t.is(await A.engine.visitSentToday(now), 1)
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: false }, 'the same person twice in a day: refused')

  t.alike(await A.engine.pullVisits(A.own, { since: today }), { added: 0, supported: true }, 'the sender files nothing (no self copy)')
  t.alike(await B.engine.pullVisits(B.own, { since: today }), { added: 1, supported: true })
  t.alike(await B.engine.visitList(B.own, now), [{ key: A.own, at: visitsCore.dayMs(today) }])
  t.alike(await B.engine.pullVisits(B.own, { since: today }), { added: 0, supported: true }, 'the cursor moved')
  const raw = JSON.stringify(await B.storage.readJson('dmVisits'))
  t.absent(raw.includes(A.own), 'the list is sealed at rest')
})

test('visitas: a ping replayed after visits.clear never files the visitor again; stale and pre-switch days are dropped', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc)
  const B = await visitEngine(t, pool, assoc)
  const C = await visitEngine(t, pool, assoc)
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  const yesterday = visitsCore.visitDay(now - 86400000)
  const old = visitsCore.visitDay(now - 3 * 86400000)
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  await until(() => pool.puts === 1)
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 1)
  await B.engine.visitClear()
  t.alike(await B.engine.visitList(B.own, now), [], 'cleared')
  // The same drop put again at a new seq (a replay within the day slack).
  pool.entries.push({ seq: pool.entries.length + 1, bytes: pool.entries[0].bytes })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 0, 'the replay is not filed')
  t.alike(await B.engine.visitList(B.own, now), [])

  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, B, assoc, yesterday) })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 0, 'a day before the switch went on is dropped')
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, B, assoc, old) })
  t.is((await B.engine.pullVisits(B.own, { since: old })).added, 0, 'a stale day is dropped (visitDayFresh)')
  await store.writeMemberBlocks(B.storage, [{ key: C.own, on: true, t: 1 }])
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, B, assoc, today) })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 0, 'a blocked sender is dropped')
  await store.writeMemberBlocks(B.storage, [])
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, B, assoc, today) })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 1, 'the same sender unblocked files')
  t.alike((await B.engine.visitList(B.own, now)).map((r) => r.key), [C.own])
})

test('an injected identity is what the engine reads: the cert, the blocklist, the member blocks and the follows', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const kpA = crypto.keyPair()
  const folds = []
  const A = await visitEngine(t, pool, assoc, { kp: kpA, certified: false })
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: 'ee'.repeat(32), box: A.box, now: Date.now() }), { queued: false }, 'no diary and no identity.cert: no certificate')

  const cert = createCert({ member: hex(kpA.publicKey) }, assoc)
  const S = await visitEngine(t, pool, assoc, { kp: kpA, certified: false, identity: { cert: async () => cert } })
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, assoc)
  let snapshot = createSnapshot({ seq: 1, blocked: [S.own] }, mod, modCert)
  let blocks = []
  const B = await visitEngine(t, pool, assoc, {
    identity: {
      memberBlocks: async () => blocks,
      blocklist: async () => snapshot === null ? null : { v: 1, snapshot },
      follows: async () => [{ key: 'f1'.repeat(32) }, 'f2'.repeat(32)]
    },
    limits: { fold: (args) => { folds.push(args); return require('@varanda/core/lib/dm-fold').fold(args) } }
  })
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  t.alike(await S.engine.visitQueue(S.own, S.kp, { to: B.own, box: B.box, now }), { queued: true }, 'the cert served by identity.cert lets it send')
  await until(() => pool.puts === 1)
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 0, 'a sender on identity.blocklist is dropped; the storage has no blocklist')
  snapshot = null
  blocks = [{ key: S.own, on: true, t: 1 }]
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(S, B, assoc, today) })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 0, 'a sender in identity.memberBlocks is dropped; the storage has no blocks')
  blocks = []
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(S, B, assoc, today) })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 1, 'unblocked there, it files')

  await B.engine.list(B.own, { folder: 'inbox' })
  t.alike(folds[folds.length - 1].followSet, ['f1'.repeat(32), 'f2'.repeat(32)], 'identity.follows reaches the fold')
  t.exception.all(() => createDmEngine({ storage: memoryNodeStorage(), association: hex(assoc.publicKey), identity: { cert: 1 } }), /identity\.cert/)
  t.exception.all(() => createDmEngine({ storage: memoryNodeStorage(), association: hex(assoc.publicKey), identity: 'x' }), /identity/)
  t.exception.all(() => createDmEngine({ storage: memoryNodeStorage(), association: hex(assoc.publicKey), identity: null }), /identity/)
  t.exception.all(() => createDmEngine({ storage: memoryNodeStorage(), association: hex(assoc.publicKey), identity: [] }), /identity/)
})

test('visitas: the budget keeps the last 5 stamps; an uncertain put is never sent again; no visit lane keeps the queue', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc, { stamps: 6 })
  const B = await visitEngine(t, pool, assoc)
  const C = await visitEngine(t, pool, assoc)
  const now = Date.now()
  pool.unsupported = true
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: C.own, box: C.box, now }), { queued: false }, 'a 6th stamp would be spent: refused')
  t.is((await A.engine.visitAllowed(A.own, C.own, now)).ok, false)
  await A.engine.flushVisits()
  await A.engine.idle()
  t.is(pool.puts, 0, 'a seeder without the lane takes nothing')
  t.is(pool.dmPuts, 0, 'and nothing falls back to the dm channel')
  t.is(await A.engine.walletSize(), 6)
  t.alike(await B.engine.pullVisits(B.own, { since: visitsCore.visitDay(now) }), { added: 0, supported: false })

  pool.unsupported = false
  pool.failPut = true
  await A.engine.flushVisits()
  await A.engine.idle()
  t.is(pool.puts, 1, 'put once')
  t.is(await A.engine.walletSize(), 5, 'its stamp spent')
  await A.engine.flushVisits()
  await A.engine.idle()
  t.is(pool.puts, 1, 'an uncertain put is never sent again')
  t.is(await A.engine.visitSentToday(now), 1, 'it still counts')
})

test('visitas: a delayed ping waits for its time; the queue is sealed at rest, and clearing it drops the ping unsent', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc, { limits: { visitDelay: () => 60000 } })
  const B = await visitEngine(t, pool, assoc)
  const now = Date.now()
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  await A.engine.flushVisits()
  t.is(pool.puts, 0, 'not due yet')
  const raw = JSON.stringify(await A.storage.readJson('dmVisitQueue'))
  t.absent(raw.includes(B.own), 'the queue is sealed at rest')
  await A.engine.visitClear({ queue: true })
  t.is(await A.storage.readJson('dmVisitQueue'), null)
  await A.engine.flushVisits()
  t.is(pool.puts, 0, 'dropped unsent')
})

test('visitas: a switch read as off on a second device sends nothing from its queue and empties its list; rows before a new on-day are never listed', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const B = await visitEngine(t, pool, assoc)
  const C = await visitEngine(t, pool, assoc)
  // The second device: its timer hands over to visitsDue, which reads the
  // switch (as the session's visitPull) before any send.
  const sw = { on: true, calls: 0 }
  const D = await visitEngine(t, pool, assoc, {
    visitsDue: () => {
      sw.calls++
      return sw.on ? D.engine.flushVisits() : D.engine.visitClear({ queue: true })
    }
  })
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  const yesterday = visitsCore.visitDay(now - 86400000)
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, D, assoc, today) })
  t.is((await D.engine.pullVisits(D.own, { since: today })).added, 1)
  t.is((await D.engine.visitList(D.own, now, { since: today })).length, 1)

  sw.on = false
  t.alike(await D.engine.visitQueue(D.own, D.kp, { to: B.own, box: B.box, now }), { queued: true })
  await until(() => sw.calls >= 1)
  await D.engine.idle()
  t.is(pool.puts, 0, 'nothing sent: the timer never flushes past the switch')
  t.is(await D.storage.readJson('dmVisitQueue'), null, 'the queue is emptied')
  t.alike(await D.engine.visitList(D.own, now, { since: today }), [], 'the list is emptied')

  // A row from yesterday, then the switch goes on again today.
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, D, assoc, yesterday) })
  t.is((await D.engine.pullVisits(D.own, { since: yesterday })).added, 1)
  t.alike(await D.engine.visitList(D.own, now, { since: today }), [], 'a row before the new on-day is not listed')
  t.alike(await D.engine.visitList(D.own, now), [], 'and it is gone at rest')
  t.alike(await D.engine.visitList(D.own, now, { since: 'ontem' }), [], 'an invalid since lists nothing')
})

test('visitas: a put refused with cheio or ritmo gives the stamp back and keeps the ping queued', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc)
  const B = await visitEngine(t, pool, assoc)
  const now = Date.now()
  pool.unsupported = true
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  await A.engine.idle()
  pool.unsupported = false
  for (const reason of ['cheio', 'ritmo']) {
    pool.refuse = reason
    const puts = pool.puts
    await A.engine.flushVisits()
    await A.engine.idle()
    t.is(pool.puts, puts + 1, reason + ': put once')
    t.is(await A.engine.walletSize(), 8, reason + ': the stamp is back')
    t.is(pool.entries.length, 0)
  }
  pool.refuse = null
  await A.engine.flushVisits()
  await A.engine.idle()
  t.is(pool.entries.length, 1, 'the ping goes out on a later flush')
  t.is(await A.engine.walletSize(), 7, 'one stamp spent in all')
  t.is(await A.engine.visitSentToday(now), 1, 'counted once')
})

test('visitas: a list filed under an older on-record is wiped with the queue (off and on again on another device)', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const B = await visitEngine(t, pool, assoc)
  const C = await visitEngine(t, pool, assoc)
  const D = await visitEngine(t, pool, assoc)
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, D, assoc, today) })
  t.is((await D.engine.pullVisits(D.own, { since: today, on: 5 })).added, 1)
  t.is((await D.engine.visitList(D.own, now, { since: today, on: 5 })).length, 1, 'the same on-record keeps the list')
  pool.unsupported = true
  t.alike(await D.engine.visitQueue(D.own, D.kp, { to: B.own, box: B.box, now }), { queued: true })
  await D.engine.idle()
  pool.unsupported = false
  // The switch went off and on again (seq 7) the same day on another device.
  t.alike(await D.engine.visitList(D.own, now, { since: today, on: 7 }), [], 'the old rows are wiped')
  t.is(await D.storage.readJson('dmVisitQueue'), null, 'the old queue is wiped')
  await D.engine.flushVisits()
  await D.engine.idle()
  t.is(pool.puts, 0, 'nothing from the old queue goes out')
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(B, D, assoc, today) })
  t.is((await D.engine.pullVisits(D.own, { since: today, on: 7 })).added, 1, 'new pings file under the new on-record')
  t.alike((await D.engine.visitList(D.own, now, { since: today, on: 7 })).map((r) => r.key), [B.own])
})

test('visitas: a blocks read that fails files and lists nothing (fails closed)', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const C = await visitEngine(t, pool, assoc)
  const D = await visitEngine(t, pool, assoc)
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, D, assoc, today) })
  const readMemberBlocks = store.readMemberBlocks
  store.readMemberBlocks = async () => { throw new Error('falha de leitura') }
  try {
    t.is((await D.engine.pullVisits(D.own, { since: today })).added, 0, 'nothing filed')
    t.alike(await D.engine.visitList(D.own, now, { since: today }), [], 'nothing listed')
  } finally {
    store.readMemberBlocks = readMemberBlocks
  }
  t.is((await D.engine.pullVisits(D.own, { since: today })).added, 1, 'filed once the read works')
  t.is((await D.engine.visitList(D.own, now, { since: today })).length, 1)
})

test('visitas: a flush puts at most DM_PUT_BURST pings; the rest stay queued with their stamps', async (t) => {
  const { DM_PUT_BURST } = require('@varanda/core/lib/dm-net')
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc, { stamps: 20 })
  const now = Date.now()
  pool.unsupported = true
  const n = DM_PUT_BURST + 1
  for (let i = 0; i < n; i++) {
    const R = await visitEngine(t, pool, assoc)
    t.alike(await A.engine.visitQueue(A.own, A.kp, { to: R.own, box: R.box, now }), { queued: true })
  }
  await A.engine.idle()
  t.is(pool.puts, 0)
  pool.unsupported = false
  await A.engine.flushVisits()
  await A.engine.idle()
  t.is(pool.puts, DM_PUT_BURST, 'one burst')
  t.is(await A.engine.walletSize(), 20 - DM_PUT_BURST, 'only the pings put took a stamp')
  t.is(await A.engine.visitSentToday(now), n, 'all still count')
  await A.engine.flushVisits()
  await A.engine.idle()
  t.is(pool.puts, DM_PUT_BURST + 1, 'the rest go on a later flush')
  t.is(await A.engine.walletSize(), 20 - n)
})

test('visitas: a clear between a ping leaving the queue and its put stops the flush before the put', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const A = await visitEngine(t, pool, assoc)
  const B = await visitEngine(t, pool, assoc)
  const C = await visitEngine(t, pool, assoc)
  const now = Date.now()
  pool.unsupported = true
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: C.own, box: C.box, now }), { queued: true })
  await A.engine.idle()
  pool.unsupported = false
  const writeJson = A.storage.writeJson
  let armed = true
  A.storage.writeJson = async function (k, v) {
    const r = await writeJson.call(this, k, v)
    // The dequeue's write: the switch goes off right then.
    if (armed && k === 'dmVisitQueue' && v !== null) {
      armed = false
      A.engine.visitClear({ queue: true })
    }
    return r
  }
  await A.engine.flushVisits()
  await A.engine.idle()
  A.storage.writeJson = writeJson
  t.is(pool.puts, 0, 'the dequeued ping is not sent')
  t.is(await A.engine.walletSize(), 7, 'and nothing more is spent')
  t.is(await A.storage.readJson('dmVisitQueue'), null)
})

test('visitas: rows older than 30 days are dropped at rest when the list is read', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = visitPool()
  const B = await visitEngine(t, pool, assoc)
  const C = await visitEngine(t, pool, assoc)
  const now = Date.now()
  const today = visitsCore.visitDay(now)
  pool.entries.push({ seq: pool.entries.length + 1, bytes: handPing(C, B, assoc, today) })
  t.is((await B.engine.pullVisits(B.own, { since: today })).added, 1)
  const before = (await B.storage.readJson('dmVisits')).box
  t.alike(await B.engine.visitList(B.own, now + visitsCore.VISIT_KEEP_DAYS * 86400000), [], 'past 30 days: not listed')
  t.not((await B.storage.readJson('dmVisits')).box, before, 'rewritten at rest')
  t.alike(await B.engine.visitList(B.own, now), [], 'and gone, not only hidden')
})

// ---- buckets (docs/protocol.md section 11, "Buckets") ----

const prefixOfBox = (boxHex) => dmCore.bucketPrefix(boxHex)

// A prf whose box prefix is not among `taken`: three nodes then sit in three
// buckets at 6 bits, whatever the random keys are.
async function prfWithPrefix (taken) {
  for (;;) {
    const prf = crypto.randomBytes(32)
    const p = prefixOfBox(hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey))
    if (!taken.includes(p)) return { prf, p }
  }
}

test('buckets: a pull downloads only its own bucket and the untagged drops; every drop is tagged by the box it is sealed to', async (t) => {
  t.timeout(300000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc, bits: 6 })
  const a = await prfWithPrefix([])
  const b = await prfWithPrefix([a.p])
  const c = await prfWithPrefix([a.p, b.p])
  const A = await memberNode(t, assoc, seeder.url, { prf: a.prf })
  const B = await memberNode(t, assoc, seeder.url, { prf: b.prf })
  const C = await memberNode(t, assoc, seeder.url, { prf: c.prf })
  await copyDiary(B, A)
  await copyDiary(C, A)
  await copyDiary(A, B)

  await A.web.request('dm.send', { to: C.key, text: 'um' })
  await A.web.request('dm.send', { to: C.key, text: 'dois' })
  await A.web.request('dm.send', { to: B.key, text: 'tres' })
  t.is(seeder.puts.length, 6)
  t.alike(seeder.putInfos.map((i) => i.bucket), [c.p, a.p, c.p, a.p, b.p, a.p], 'recipient copy by the peer box, self copy by the own box')
  t.ok(seeder.putInfos.every((i) => i.bits === 6))

  seeder.served = 0
  t.is((await B.web.request('dm.pull')).added, 1)
  t.is(seeder.served, 1, 'B downloaded its own drop only, not the five others')
  t.is((await C.web.request('dm.pull')).added, 2)
  t.is(seeder.served, 3, 'C downloaded its two')
  await A.web.request('dm.pull')
  t.is(seeder.served, 6, 'A downloaded its three self copies: every drop once')
  t.ok(seeder.pageQueries.length > 0)
  t.alike(seeder.pageQueries[0], { buckets: [b.p], bits: 6 }, 'the page names one bucket')
})

test('buckets: a seeder without the v2 lane gets v1: untagged puts, the whole pool, and the message still arrives', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(B, A)
  await copyDiary(A, B)
  await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.is(seeder.puts.length, 2)
  t.ok(seeder.putInfos.every((i) => i === null), 'v1 puts carry no bucket')
  t.is((await B.web.request('dm.pull')).added, 1)
  t.is(seeder.pageQueries.length, 0)
  t.is(seeder.served, 2, 'v1 returns the whole pool')
})

test('buckets: a seeder that opens v2 claiming more than 6 bits is dropped for v1 and the message still arrives', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc, bits: 6, spoofBits: 7 })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(B, A)
  await copyDiary(A, B)
  await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.is(seeder.puts.length, 2)
  t.ok(seeder.putInfos.every((i) => i === null), 'the puts went on v1, untagged')
  t.is((await B.web.request('dm.pull')).added, 1)
  t.is(seeder.pageQueries.length, 0, 'no page on the lane that claimed 7 bits')
  t.alike((await B.web.request('dm.thread', { peer: A.key })).messages.map((m) => m.text), ['oi'])
})

test('buckets: a seeder at 0 bits gets everything tagged as bucket 0 and the pull still delivers', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc, bits: 0 })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(B, A)
  await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.ok(seeder.putInfos.every((i) => i.bits === 0 && i.bucket === 0))
  t.is((await B.web.request('dm.pull')).added, 1)
  t.alike(seeder.pageQueries[0], { buckets: [0], bits: 0 })
})

test('buckets: send, reaction and ctl puts carry the prefix of the box they are sealed to', async (t) => {
  const s = await sendingEngine(t, { stamps: 6 })
  const own = prefixOfBox(s.engine.boxHex().box)
  const peer = prefixOfBox(s.recipientBox)
  const sent = await s.send()
  t.alike(s.link.prefixes, [peer, own], 'recipient first, then the self copy')
  s.link.prefixes.length = 0
  await s.engine.react(s.own, s.kp, { to: s.peer, target: { from: s.own, id: sent.id }, emoji: '\u{1f44d}' }, s.recipientBox)
  t.alike(s.link.prefixes, [peer, own])
  s.link.prefixes.length = 0
  await s.set()
  t.alike(s.link.prefixes, [own], 'a ctl goes to the own box')
})

test('buckets: a stored reaction keeps its prefixes across a reload; one stored before has none and goes untagged', async (t) => {
  const s = await sendingEngine(t, { stamps: 6 })
  const ownPrefix = prefixOfBox(s.engine.boxHex().box)
  const sent = await s.send()
  s.link.prefixes.length = 0
  const target = { from: s.own, id: sent.id }
  const react = (engine) => engine.react(s.own, s.kp, { to: s.peer, target, emoji: '\u{1f44d}' }, s.recipientBox)
  s.link.offline = true
  await errorOf(react(s.engine))
  const engine = await reloaded(t, s)
  s.link.offline = false
  await react(engine)
  t.alike(s.link.prefixes, [prefixOfBox(s.recipientBox), ownPrefix], 'kept inside the sealed item')

  // The same op as an earlier build stored it: no prefixes in the item.
  const s2 = await sendingEngine(t, { stamps: 6 })
  const sent2 = await s2.send()
  s2.link.prefixes.length = 0
  s2.link.offline = true
  await errorOf(s2.engine.react(s2.own, s2.kp, { to: s2.peer, target: { from: s2.own, id: sent2.id }, emoji: '\u{1f44d}' }, s2.recipientBox))
  const local = await opener(s2.prf)
  const items = await reactPending(s2.storage)
  const meta = local.open(items[0].meta)
  t.ok(Array.isArray(meta.prefixes), 'the new build stores prefixes')
  delete meta.prefixes
  await s2.storage.writeJson('dmReactPending', { v: 1, items: [{ ...items[0], meta: local.seal(meta) }] })
  const engine2 = await reloaded(t, s2)
  s2.link.offline = false
  await engine2.react(s2.own, s2.kp, { to: s2.peer, target: { from: s2.own, id: sent2.id }, emoji: '\u{1f44d}' }, s2.recipientBox)
  t.alike(s2.link.prefixes, [null, null], 'an item from before goes untagged')
})

test('buckets: a queued visit ping is put with the prefix of the recipient box', async (t) => {
  const assoc = generateAssociationKeyPair()
  const seen = []
  const pool = visitPool()
  const link = pool.link
  pool.link = () => {
    const l = link()
    const put = l.put
    l.put = (bytes, prefix) => {
      seen.push(prefix === undefined ? null : prefix)
      return put(bytes)
    }
    return l
  }
  const A = await visitEngine(t, pool, assoc)
  const B = await visitEngine(t, pool, assoc)
  const now = Date.now()
  t.alike(await A.engine.visitQueue(A.own, A.kp, { to: B.own, box: B.box, now }), { queued: true })
  await until(() => seen.length === 1)
  await A.engine.idle()
  t.alike(seen, [prefixOfBox(B.box)])
})

// ---- local compaction of deleted conversations (lib/dm-store.js compact) ----

const DAY = 86400000

// The own store with its compaction calls counted; failCompact makes them throw.
function compactSpy (counts, { failCompact = false } = {}) {
  return (options) => {
    const s = createDmStore(options)
    const compact = s.compact
    const drop = s.dropDeletedMedia
    s.compact = (now) => {
      counts.compact++
      if (failCompact) return Promise.reject(new Error('disco cheio'))
      return compact(now)
    }
    s.dropDeletedMedia = () => {
      counts.media++
      return drop()
    }
    return s
  }
}

// Which blocks of the dm-local core still hold data.
async function localBlocks (storage) {
  const core = new Hypercore(storage.core(store.DM_LOCAL), { valueEncoding: 'binary' })
  await core.ready()
  const out = []
  for (let i = 0; i < core.length; i++) out.push((await core.get(i, { wait: false })) !== null)
  await core.close()
  return out
}

async function compactingEngine (t, { failCompact = false } = {}) {
  const clock = { t: Date.now() }
  const counts = { compact: 0, media: 0 }
  const logs = []
  const s = await sendingEngine(t, {
    stamps: 6,
    options: { log: (line) => logs.push(line), limits: { now: () => clock.t }, createStore: compactSpy(counts, { failCompact }) }
  })
  s.link.page = async () => ({ items: [], next: null })
  await s.engine.idle()
  return { ...s, clock, counts, logs }
}

test('dm.set deleted compacts the own store, but only past the pool retention; a reload and an hourly pull free aged rows', async (t) => {
  const s = await compactingEngine(t)
  t.is(s.counts.compact, 1, 'once the rows loaded')
  await s.send()
  await s.engine.set(s.own, s.kp, { peer: s.peer, state: 'deleted' })
  await s.engine.idle()
  t.is(s.counts.compact, 2, 'right after the delete op was filed')
  t.is(s.counts.media, 2)
  t.alike(await localBlocks(s.storage), [true, true], 'inside the bound the blocks stay')
  t.is((await s.engine.thread(s.own, { peer: s.peer })).messages.length, 0, 'hidden by the fold anyway')

  // A long session: nothing pulled yet, an hour later a pull frees what aged.
  s.clock.t += 2 * DAY
  await s.engine.pull(s.own)
  await s.engine.idle()
  t.is(s.counts.compact, 3, 'a pull past the hour runs a pass')
  t.alike(await localBlocks(s.storage), [true, true], 'two days: still inside the bound')
  s.clock.t += 10 * 60000
  await s.engine.pull(s.own)
  await s.engine.idle()
  t.is(s.counts.compact, 3, 'at most once an hour')
  s.clock.t += 40 * DAY
  await s.engine.pull(s.own)
  await s.engine.idle()
  t.is(s.counts.compact, 4)
  t.alike(await localBlocks(s.storage), [false, true], 'the message block is freed, the ctl stays')
})

test('a reload frees the rows of a deleted conversation that aged while the device was locked', async (t) => {
  const s = await compactingEngine(t)
  await s.send()
  await s.engine.set(s.own, s.kp, { peer: s.peer, state: 'deleted' })
  await s.engine.idle()
  t.alike(await localBlocks(s.storage), [true, true])
  s.engine.lock()
  s.clock.t += 40 * DAY
  await s.engine.unlock(s.prf)
  await s.engine.loaded()
  await s.engine.idle()
  t.alike(await localBlocks(s.storage), [false, true], 'freed once the rows loaded')
})

test('without a delete op nothing is freed, however old the rows', async (t) => {
  const s = await compactingEngine(t)
  await s.send()
  s.clock.t += 400 * DAY
  await s.engine.pull(s.own)
  await s.engine.idle()
  t.ok(s.counts.compact >= 2)
  t.alike(await localBlocks(s.storage), [true])
  t.is((await s.engine.thread(s.own, { peer: s.peer })).messages.length, 1)
})

test('a delete op pulled from another own device compacts too', async (t) => {
  const first = await compactingEngine(t)
  const drops = []
  first.link.put = async (bytes) => { drops.push(new Uint8Array(bytes)); return { ok: true, reason: null } }
  first.link.page = async () => ({ items: drops.map((bytes, i) => ({ bytes, seq: i + 1 })), next: null })
  await first.send()
  // The sibling's clock is 40 days ahead from its start (the filing time of
  // a row is the real one, the compaction age is this clock minus it), so
  // its unlock pass is the first and the hourly window is still closed when
  // it pulls: only the delete op itself can start the second pass.
  const other = await sendingEngineSibling(t, first, 40 * DAY)
  await other.engine.idle()
  t.is(other.counts.compact, 1, 'the unlock pass')
  // Both drops of the send and the ctl: the other device files the self copy and the delete together.
  await first.engine.set(first.own, first.kp, { peer: first.peer, state: 'deleted' })
  t.is((await other.engine.pull(first.own)).added, 1, 'the self copy is filed')
  await other.engine.idle()
  t.is(other.counts.compact, 2, 'exactly one more pass, for the delete op')
  t.alike(await localBlocks(other.storage), [false, true], 'the message block is freed past the bound')
  t.is((await other.engine.thread(first.own, { peer: first.peer })).messages.length, 0)
})

// Another device of the same passkey and identity on the same pool stand-in.
async function sendingEngineSibling (t, first, ahead = 0) {
  const clock = { t: Date.now() + ahead }
  const counts = { compact: 0, media: 0 }
  const storage = memoryNodeStorage()
  const engine = engineWithDmLink(first.link)({ storage, association: first.association, limits: { now: () => clock.t }, createStore: compactSpy(counts) })
  t.teardown(() => engine.close(), { force: true })
  await engine.unlock(first.prf)
  await engine.loaded()
  return { engine, storage, clock, counts }
}

test('a failing compaction is a warning: dm.set and the pull still succeed', async (t) => {
  const s = await compactingEngine(t, { failCompact: true })
  await s.send()
  t.alike(await s.engine.set(s.own, s.kp, { peer: s.peer, state: 'deleted' }), { ok: true })
  s.clock.t += 40 * DAY
  const pulled = await s.engine.pull(s.own)
  t.is(pulled.incomplete, false)
  await s.engine.idle()
  t.ok(s.logs.some((l) => l.startsWith('aviso: limpeza local')), 'warned')
  t.alike(await localBlocks(s.storage), [true, true], 'nothing was freed')
})
