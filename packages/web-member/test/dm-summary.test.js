'use strict'

// The sealed dm.list summary (lib/dm-store.js, docs/protocol.md section 11):
// with the row load held, a first page answers from it only while it opens
// under the key, names this core, matches its length and both kv digests;
// in every other case dm.list waits for the rows. No network in the engine
// tests: rows are filed straight into the store and the engine never dials.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createDmEngine } = require('../lib/dm')
const { createDmStore } = require('../lib/dm-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmLocalKeyFromPrf } = require('../lib/passkey')
const sodium = require('../lib/sodium-browser')
const store = require('../lib/node-store')
const { connectClient } = require('./helpers/session')
const { dmSeeder } = require('./helpers/dm-seeder')

const OWN = 'cd'.repeat(32)
const PEERS = ['a1', 'b2', 'c3', 'd4'].map((b) => b.repeat(32))
const ASSOC_KP = generateAssociationKeyPair()
const ASSOC = b4a.toString(ASSOC_KP.publicKey, 'hex')
const SUMMARY_KEY_DOMAIN = b4a.from('varanda/member-dm-local/summary-key/v1\n', 'utf8')
const SECRET = 'segredo do resumo'

function noop () {}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until (fn, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(20)
  }
  return false
}

// Holds every row load while held.
function loadGate () {
  const g = { held: false, waiters: [] }
  g.wait = () => g.held ? new Promise((resolve) => g.waiters.push(resolve)) : Promise.resolve()
  g.release = () => {
    g.held = false
    for (const w of g.waiters.splice(0)) w()
  }
  return g
}

function engineFor (storage, gate = loadGate()) {
  let local = null
  const engine = createDmEngine({
    storage,
    association: ASSOC,
    seederUrl: 'ws://127.0.0.1:9',
    createSocket: () => { throw new Error('no network in this test') },
    limits: { summaryDelayMs: 0, loadGate: () => gate.wait() },
    createStore: (opts) => {
      local = createDmStore(opts)
      return local
    }
  })
  return { engine, gate, store: () => local }
}

function msg (filedAt, { peer, mine = false, at, text = SECRET }) {
  return { t: 'msg', id: b4a.toString(crypto.randomBytes(16), 'hex'), peer, from: mine ? OWN : peer, text, replyTo: null, at, mine, filedAt }
}

// A store with a followed peer, two requests and an own conversation, its
// summary written. -> { storage, prf, inbox, requests }
async function seeded (t) {
  const storage = memoryNodeStorage()
  const prf = crypto.randomBytes(32)
  const { engine, store: local } = engineFor(storage)
  await store.writeFollows(storage, [PEERS[0]])
  await engine.unlock(prf)
  const s = local()
  await s.append([
    msg(s.nextFiled(), { peer: PEERS[0], at: '2026-11-10T09:00:00.000Z' }),
    msg(s.nextFiled(), { peer: PEERS[1], at: '2026-11-10T09:01:00.000Z' }),
    msg(s.nextFiled(), { peer: PEERS[3], at: '2026-11-10T09:02:00.000Z' }),
    msg(s.nextFiled(), { peer: PEERS[2], mine: true, at: '2026-11-10T09:03:00.000Z' })
  ])
  const inbox = await engine.list(OWN)
  const requests = await engine.list(OWN, { folder: 'request' })
  t.is(inbox.conversations.length, 2)
  t.is(requests.conversations.length, 2)
  t.ok(await until(async () => (await storage.readJson('dmSummary')) !== null), 'the fold wrote the summary')
  await engine.close()
  return { storage, prf, inbox, requests }
}

// A new engine on `storage` whose row load is held. -> { engine, gate,
// unlocking, keyed, store }; keyed: onKey ran before the rows loaded.
async function reopenHeld (storage, prf) {
  const gate = loadGate()
  gate.held = true
  const { engine, store: local } = engineFor(storage, gate)
  let keyed = false
  let onKey
  const ready = new Promise((resolve) => { onKey = resolve })
  const unlocking = engine.unlock(prf, {
    onKey: () => {
      keyed = !engine.unlocked()
      onKey()
    }
  })
  unlocking.catch(noop)
  await Promise.race([ready, unlocking.catch(noop), sleep(5000)])
  return { engine, gate, unlocking, keyed, store: local }
}

// -> a function that reports whether `p` settled yet.
function watch (p) {
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  return () => settled
}

async function summaryKeyOf (prf) {
  const k = await dmLocalKeyFromPrf(prf)
  const out = crypto.hash([SUMMARY_KEY_DOMAIN, k])
  k.fill(0)
  return out
}

function openBox (sealed, k) {
  const box = b4a.from(sealed.box, 'base64')
  const plain = b4a.alloc(box.byteLength - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(plain, box, b4a.from(sealed.nonce, 'hex'), k)) return null
  return JSON.parse(b4a.toString(plain, 'utf8'))
}

function sealBox (value, k) {
  const plain = b4a.from(JSON.stringify(value), 'utf8')
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(plain.byteLength + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(box, plain, nonce, k)
  return { v: 1, nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') }
}

// Rewrites the stored summary, resealed under the same key.
async function edit (storage, prf, fn) {
  const k = await summaryKeyOf(prf)
  const value = openBox(await storage.readJson('dmSummary'), k)
  fn(value)
  await storage.writeJson('dmSummary', sealBox(value, k))
}

test('with the row load held, a first page answers from the summary and equals the fold; dm.thread waits', async (t) => {
  const { storage, prf, inbox, requests } = await seeded(t)
  const { engine, gate, unlocking, keyed } = await reopenHeld(storage, prf)
  t.teardown(() => engine.close())
  // Fails before the summary: the unlock never reports its keys apart from
  // the row load.
  t.ok(keyed, 'the keys are ready while the rows are held')
  t.absent(engine.unlocked(), 'the rows are still loading')
  t.alike(await engine.list(OWN), inbox, 'the inbox page equals the folded one')
  t.alike(await engine.list(OWN, { folder: 'request' }), requests, 'the request page equals the folded one')
  const one = await engine.list(OWN, { limit: 1 })
  t.is(gate.waiters.length, 1, 'still held')

  const thread = engine.thread(OWN, { peer: PEERS[0] })
  const threadDone = watch(thread)
  const later = engine.list(OWN, { before: inbox.next || inbox.conversations[0] })
  const laterDone = watch(later)
  await sleep(50)
  t.absent(threadDone(), 'dm.thread waits for the row load')
  t.absent(laterDone(), 'a later page waits too')
  gate.release()
  await unlocking
  t.is((await thread).messages.length, 1, 'dm.thread answers after the load')
  await later
  t.alike(one, await engine.list(OWN, { limit: 1 }), 'a shorter first page equals the folded one')
  t.ok(engine.unlocked())
})

const MISSES = [
  ['another key', null],
  ['another core', (v) => { v.core = 'ee'.repeat(32) }],
  ['another length', (v) => { v.length += 1 }],
  ['a changed follows list', 'follows'],
  ['a changed seen set', 'seen'],
  ['a tampered box', 'tamper']
]

for (const [name, change] of MISSES) {
  test('a summary of ' + name + ' is ignored and dm.list waits for the load', async (t) => {
    const seed = await seeded(t)
    const { storage } = seed
    let prf = seed.prf
    if (change === null) prf = crypto.randomBytes(32)
    else if (change === 'follows') await store.writeFollows(storage, [PEERS[0], PEERS[1]])
    else if (change === 'seen') await store.writeDmSeen(storage, ['ab'.repeat(16)])
    else if (change === 'tamper') {
      const v = await storage.readJson('dmSummary')
      const box = b4a.from(v.box, 'base64')
      box[box.byteLength - 1] ^= 1
      await storage.writeJson('dmSummary', { ...v, box: b4a.toString(box, 'base64') })
    } else await edit(storage, prf, change)

    const { engine, gate, unlocking } = await reopenHeld(storage, prf)
    t.teardown(() => engine.close())
    t.absent(engine.unlocked())
    const list = engine.list(OWN)
    const done = watch(list)
    await sleep(50)
    t.absent(done(), 'dm.list waits for the rows')
    gate.release()
    await unlocking
    const got = await list
    t.alike(got, await engine.list(OWN), 'and then answers the fold')
    if (change === null) t.is(got.conversations.length, 0, 'another identity reads nothing of the first one')
  })
}

test('a second identity never reads the first one\'s summary, and its load deletes it', async (t) => {
  const { storage } = await seeded(t)
  const before = await storage.readJson('dmSummary')
  const { engine, gate, unlocking, store: local } = await reopenHeld(storage, crypto.randomBytes(32))
  t.teardown(() => engine.close())
  t.is(local().summaryFor({ follows: '00'.repeat(32), seen: '00'.repeat(32) }), null)
  gate.release()
  await unlocking
  const after = await storage.readJson('dmSummary')
  t.ok(after === null || after.box !== before.box, 'the first identity\'s summary is gone')
})

test('after lock the plaintext is gone and the entry is ciphertext; wipeMedia (reset) deletes it', async (t) => {
  const { storage, prf, inbox } = await seeded(t)
  const raw = JSON.stringify(await storage.readJson('dmSummary'))
  t.absent(raw.includes(SECRET), 'no plaintext preview at rest')
  for (const p of PEERS) t.absent(raw.includes(p), 'no plaintext peer key at rest')
  t.is(openBox(await storage.readJson('dmSummary'), await summaryKeyOf(crypto.randomBytes(32))), null, 'another key cannot open it')

  const { engine, store: local, gate, unlocking } = await reopenHeld(storage, prf)
  t.teardown(() => engine.close())
  t.alike(await engine.list(OWN), inbox)
  engine.lock()
  t.absent(local().keyReady(), 'no key after lock')
  const k = await summaryKeyOf(prf)
  const v = openBox(await storage.readJson('dmSummary'), k)
  t.is(local().summaryFor({ follows: v.follows, seen: v.seen }), null, 'the plaintext is dropped at lock')
  await t.exception(engine.list(OWN), /bloqueada/, 'dm.list is locked')
  gate.release()
  await unlocking.catch(noop)

  await engine.wipeMedia()
  t.is(await storage.readJson('dmSummary'), null, 'reset and wipeCache delete the entry')
})

test('session: on a summary miss dm.list waits off the chain, so feed.read issued after it answers first', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const storage = memoryNodeStorage()
  const gate = loadGate()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const node = require('../lib/node').createBrowserNode({
    storage,
    association: b4a.toString(assoc.publicKey, 'hex'),
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { dm: { issuePaceMs: 0, loadGate: () => gate.wait() } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  t.alike((await web.request('dm.list', {})).conversations, [])

  await node.clearKeyPair()
  await storage.writeJson('dmSummary', { v: 1, nonce: '00'.repeat(24), box: b4a.toString(crypto.randomBytes(80), 'base64') })
  gate.held = true
  await node.setKeyPair(keyPair, { prf })
  t.ok(await until(() => gate.waiters.length === 1, 30000), 'the row load is held')

  const order = []
  const list = web.request('dm.list', {}).then((r) => { order.push('dm.list'); return r })
  const read = web.request('feed.read', {}).then((r) => { order.push('feed.read'); return r })
  await read
  await sleep(100)
  t.alike(order, ['feed.read'], 'feed.read answers first, dm.list still waits')
  gate.release()
  const rows = await list
  t.alike(order, ['feed.read', 'dm.list'])
  t.alike(rows.conversations, [])
})

// createBrowserNode whose DM engine runs `wrap` on each engine it creates.
function nodeFactory (wrap) {
  const dm = require('../lib/dm')
  const original = dm.createDmEngine
  const ids = [require.resolve('../lib/node'), require.resolve('../lib/session')]
  const cached = ids.map((id) => require.cache[id])
  try {
    dm.createDmEngine = (opts) => wrap(original(opts), opts)
    ids.forEach((id) => { delete require.cache[id] })
    return require('../lib/node').createBrowserNode
  } finally {
    dm.createDmEngine = original
    ids.forEach((id, i) => { require.cache[id] = cached[i] })
  }
}

function nodeOptions (storage, assoc, seeder, gate) {
  return {
    storage,
    association: b4a.toString(assoc.publicKey, 'hex'),
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { dm: { issuePaceMs: 0, summaryDelayMs: 0, loadGate: () => gate.wait() } },
    writeGate: false
  }
}

test('session: a summary a queued step invalidates never holds the chain; dm.list waits off it and answers', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const first = require('../lib/node').createBrowserNode(nodeOptions(storage, assoc, seeder, loadGate()))
  await first.setKeyPair(keyPair, { prf })
  const web1 = await connectClient(first, { timeoutMs: 60000 })
  const { publicKey } = await web1.request('identity.create')
  await web1.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  await web1.request('dm.list', {})
  t.ok(await until(async () => (await storage.readJson('dmSummary')) !== null), 'a summary is stored')
  await first.close()

  // What a follow.add queued ahead of dm.list does: the summary answered
  // when dm.list looked, and no longer does on the chain.
  const arm = { on: true }
  const factory = nodeFactory((engine) => {
    const ready = engine.listReady
    engine.listReady = async (params) => {
      const ok = await ready(params)
      if (ok && arm.on) {
        arm.on = false
        await store.writeFollows(storage, [PEERS[1]])
      }
      return ok
    }
    return engine
  })
  const gate = loadGate()
  gate.held = true
  const node = factory(nodeOptions(storage, assoc, seeder, gate))
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  t.ok(await until(() => gate.waiters.length === 1, 30000), 'the row load is held')

  const order = []
  const list = web.request('dm.list', {}).then((r) => { order.push('dm.list'); return r })
  // feed.read only once dm.list has queued on the chain.
  t.ok(await until(() => !arm.on), 'the summary was invalidated after dm.list looked')
  await sleep(50)
  const read = web.request('feed.read', {}).then((r) => { order.push('feed.read'); return r })
  await Promise.race([read, sleep(5000)])
  await sleep(100)
  t.alike(order, ['feed.read'], 'feed.read answers, dm.list waits off the chain')
  gate.release()
  const rows = await list
  t.alike(order, ['feed.read', 'dm.list'])
  t.alike(rows.conversations, [])
})

test('a page store whose row load failed is dropped: the next dm.list of the page unlocks it afresh', async (t) => {
  const storage = memoryNodeStorage()
  const prf = crypto.randomBytes(32)
  const id = crypto.keyPair()
  const own = b4a.toString(id.publicKey, 'hex')
  const pageKp = crypto.keyPair()
  const page = b4a.toString(pageKp.publicKey, 'hex')
  const a = engineFor(storage)
  await a.engine.unlock(prf)
  const made = a.engine.pageGenerate(own, id, { page, gen: 1, recipients: [{ member: own, box: a.engine.boxHex().box }] })
  const share = made.shares[0]
  await a.engine.pageSecrets(own, { owner: own, admins: [] }, { page, gen: 1, sealed: share.sealed, by: own, sig: share.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, ASSOC_KP) })
  t.alike((await a.engine.list(own, { page })).conversations, [])
  await a.engine.close()

  // The page's row load fails once (its media index read).
  const readJson = storage.readJson
  let fail = true
  storage.readJson = async (name) => {
    if (fail && name !== 'dmMediaIndex' && name.endsWith('dmMediaIndex')) {
      fail = false
      throw new Error('disco')
    }
    return readJson.call(storage, name)
  }
  const b = engineFor(storage)
  t.teardown(() => b.engine.close())
  await b.engine.unlock(prf)
  await t.exception(b.engine.list(own, { page }), /bloqueada/, 'the failed load answers locked')
  t.absent(fail, 'the load did fail')
  const again = await b.engine.list(own, { page })
  t.alike(again.conversations, [], 'the next call unlocks the page store again')
})
