// The browser node and the signed blocklist snapshot, against a fake seeder
// (Hypercore 10 over a WebSocket, certified by the association) that speaks
// the admission channel and 'varanda/blocklist/1' with a snapshot the test
// sets: a blocked diary is purged and skipped, a forged snapshot changes
// nothing, the adopted snapshot outlives the link (IndexedDB stand-in) and
// the own diary still recovers from the seeder for an unblocked member.
// Also: the own key blocked then unblocked on one link, a snapshot adopted
// while a run is ending, log.read of replicas from a revoked issuer, a once
// run waiting for a newer snapshot the seeder advertises (G3), and a
// revocation adopted between the quarantine verdict and block 0 reaching
// the replica.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, createModeratorCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createSnapshot, compareSnapshots } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { readBlocklist, writeBlocklist } = require('../lib/node-store')

const OFFLINE_URL = 'ws://127.0.0.1:9/seeder'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function moderator (assocKp) {
  const keyPair = crypto.keyPair()
  return { keyPair, cert: createModeratorCert({ moderator: hex(keyPair.publicKey) }, assocKp) }
}

function snapshot (mod, { seq = 1, blocked = [], revokedIssuers = [] }) {
  return createSnapshot({ seq, blocked, revokedIssuers }, mod.keyPair, mod.cert)
}

// A Hypercore 10 diary with the given records (block 0 first).
async function diary (t, records, keyPair, storage = memoryStorage()) {
  const core = new Hypercore(storage, { valueEncoding: 'json', ...(keyPair ? { keyPair } : {}) })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

function certified (assoc, text) {
  return [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name: 'Autor', bio: '' }),
    () => postRecord({ text })
  ]
}

// A seeder stand-in: role 'seeder' certified by `signer`, replicating and
// advertising `cores`, admitting whatever is announced, and holding
// `seeder.snapshot` (changeable between connections, or pushed on the open
// links with seeder.push) on the blocklist channel, attached right after the
// muxer as the real seeder does. It never adopts anything the member sends.
// `blocklistMinIntervalMs` > 0 spaces the seeder's own snapshot sends
// (blocklist-net.js sendIntervalMs) while its have still goes out at once.
async function fakeSeeder (t, { signer, cores = [], blocklistMinIntervalMs = 0 }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    snapshot: null,
    announced: [],
    connections: 0,
    links: [], // { handle, peer } per connection
    // Holds `snap` and sends it on every open link; `reject` = a key the
    // seeder drops on adoption ('rejected' broadcast, seeder.js _drop).
    push (snap, { reject = null } = {}) {
      seeder.snapshot = snap
      for (const { handle, peer } of seeder.links) {
        if (reject !== null) peer.send({ type: 'rejected', key: reject, reason: 'blocked' })
        handle.announce()
      }
    }
  }
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      seeder.connections++
      Hypercore.createProtocolStream(noise)
      const handle = attachBlocklist(noise, {
        current: () => seeder.snapshot,
        offer: async () => ({ adopted: false, reason: 'same' }),
        compare: compareSnapshots,
        minIntervalMs: blocklistMinIntervalMs
      })
      for (const core of cores) core.replicate(noise)
      const peer = attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          seeder.announced.push(msg.key)
          // A diary it already holds is admitted at the length it holds.
          const held = cores.find((core) => hex(core.key) === msg.key)
          peer.send({ type: 'admitted', key: msg.key, length: held ? held.length : (peer.remoteHave.get(msg.key) || 0) })
        }
      })
      const link = { handle, peer }
      seeder.links.push(link)
      noise.once('close', () => { seeder.links = seeder.links.filter((x) => x !== link) })
    })
  })
  return seeder
}

async function webNode (t, assoc, url, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), write = true, syncOptions = {} } = {}) {
  // The storage outlives each node (a page reload keeps IndexedDB).
  storage.close = async () => {}
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, ...syncOptions },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  if (write) {
    await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
    await web.request('post.create', { text: 'do navegador' })
  }
  return { node, web, storage, key: publicKey, keyPair }
}

async function onceRun (web, timeoutMs = 10000) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs })
  return stoppedOf(web.events, runId)
}

async function until (t, what, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.fail('timed out waiting for ' + what)
  return false
}

function warningsOf (web) {
  return web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
}

function skippedOf (result) {
  return Object.fromEntries(result.skipped.map((s) => [s.key, s.reason]))
}

test('a blocked author is purged and skipped, hidden from reads, and stays blocked offline', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const blocked = await diary(t, certified(assoc, 'bloqueado'))
  const kept = await diary(t, certified(assoc, 'mantido'))
  const A = hex(blocked.key)
  const B = hex(kept.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [blocked, kept] })
  const first = await webNode(t, assoc, seeder.url)
  for (const key of [A, B]) await first.web.request('follow.add', { key })

  // No snapshot yet: both diaries are stored.
  let stopped = await onceRun(first.web)
  t.is(stopped.reason, 'done')
  t.alike(stopped.result.downloaded, { [A]: 3, [B]: 3 })
  t.ok(await first.storage.hasCore('replica/' + A))

  // The seeder now holds a snapshot blocking A.
  const snap = snapshot(mod, { blocked: [A] })
  seeder.snapshot = snap
  stopped = await onceRun(first.web)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.ok, true)
  t.alike(skippedOf(stopped.result), { [A]: 'blocked' })
  t.alike(stopped.result.downloaded, { [B]: 3 })
  t.absent(await first.storage.hasCore('replica/' + A), 'the blocked replica was purged')
  t.ok(await first.storage.hasCore('replica/' + B), 'the other replica stays')
  t.alike((await readBlocklist(first.storage)).snapshot, snap, 'the snapshot was stored')
  t.ok(seeder.announced.includes(first.key), 'the unblocked own diary is still announced')
  const warnings = first.web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
  t.ok(warnings.includes('aviso: diário ' + A.slice(0, 8) + ' ignorado (blocked)'))

  const feed = await first.web.request('feed.read', {})
  t.absent(feed.items.some((i) => i.author === A), 'nothing from the blocked diary')
  t.ok(feed.items.some((i) => i.author === B && i.text === 'mantido'))
  t.ok(feed.skipped.some((s) => s.key === A && s.reason === 'blocked'))
  const logErr = await errorOf(first.web.request('log.read', { author: A }))
  t.is(logErr.code, 'NOT_FOUND')
  t.is(logErr.message, 'sem dados locais para este diário')
  const followErr = await errorOf(first.web.request('follow.add', { key: A }))
  t.is(followErr.code, 'USAGE')
  t.is(followErr.message, 'autor bloqueado')
  await first.node.close()

  // A fresh node over the same storage with no reachable seeder enforces
  // the stored snapshot: A is skipped before any connection.
  const offline = await webNode(t, assoc, OFFLINE_URL, { storage: first.storage, keyPair: first.keyPair, write: false })
  stopped = await onceRun(offline.web, 1500)
  t.is(stopped.result.ok, false, 'no seeder')
  t.alike(skippedOf(stopped.result), { [A]: 'blocked' })
  t.absent(await first.storage.hasCore('replica/' + A))
  const offlineFeed = await offline.web.request('feed.read', {})
  t.ok(offlineFeed.items.some((i) => i.author === B), 'the kept diary still reads offline')
  t.absent(offlineFeed.items.some((i) => i.author === A))
})

test('a forged or tampered snapshot is ignored', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const other = association()
  const target = await diary(t, certified(assoc, 'alvo'))
  const A = hex(target.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [target] })
  const { web, storage } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key: A })

  // A moderator certified by another association.
  seeder.snapshot = snapshot(moderator(other.kp), { blocked: [A] })
  let stopped = await onceRun(web)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.alike(stopped.result.downloaded, { [A]: 3 }, 'still downloaded')
  t.alike(stopped.result.skipped, [])
  t.is(await readBlocklist(storage), null, 'nothing stored')

  // A genuine moderator's snapshot edited after signing.
  const tampered = snapshot(moderator(assoc.kp), { seq: 2, blocked: [] })
  tampered.blocked = [A]
  seeder.snapshot = tampered
  stopped = await onceRun(web)
  t.is(stopped.reason, 'done')
  t.alike(stopped.result.skipped, [])
  t.ok(await storage.hasCore('replica/' + A), 'the replica stays')
  t.is(await readBlocklist(storage), null, 'nothing stored')
  const feed = await web.request('feed.read', {})
  t.ok(feed.items.some((i) => i.author === A && i.text === 'alvo'))
})

test('own diary recovery still works for an unblocked member while a snapshot is enforced', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const keyPair = crypto.keyPair()
  // The diary another device wrote; this device starts empty.
  const remote = await diary(t, certified(assoc, 'de outro aparelho'), keyPair)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [remote] })
  const snap = snapshot(mod, { blocked: ['ab'.repeat(32)] })
  seeder.snapshot = snap
  const { web, key, storage } = await webNode(t, assoc, seeder.url, { keyPair, write: false })
  t.is(key, hex(remote.key))

  const stopped = await onceRun(web)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.ok, true)
  const lines = web.events.filter((e) => e.name === 'sync.event').map((e) => e.data.line)
  t.ok(lines.includes('certificado recuperado do semeador'), 'own-recovered')
  t.ok(seeder.announced.includes(key), 'announced after the recovery')
  t.alike((await readBlocklist(storage)).snapshot, snap, 'the snapshot was adopted')
  const log = await web.request('log.read', {})
  t.is(log.entries.length, 3, 'the whole own diary arrived')
})

test('a newly revoked issuer drops the diaries it certified', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const issued = await diary(t, [
    (key) => memberCertRecord(createIssuedCert({ member: key }, issuerKp, issuerCert)),
    () => postRecord({ text: 'certificado pelo emissor' })
  ])
  const A = hex(issued.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [issued] })
  const { web, storage } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key: A })
  let stopped = await onceRun(web)
  t.is(stopped.reason, 'done')
  t.alike(stopped.result.downloaded, { [A]: 2 }, 'accepted before the revocation')

  seeder.snapshot = snapshot(mod, { revokedIssuers: [hex(issuerKp.publicKey)] })
  stopped = await onceRun(web)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.alike(skippedOf(stopped.result), { [A]: 'revoked-issuer' })
  t.absent(await storage.hasCore('replica/' + A), 'purged')
  const feed = await web.request('feed.read', {})
  t.absent(feed.items.some((i) => i.author === A))
})

test('own key blocked then unblocked in one continuous run is announced again on the same link', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const me = await webNode(t, assoc, seeder.url, { syncOptions: { blocklistMinIntervalMs: 0 } })
  const announces = () => seeder.announced.filter((k) => k === me.key).length
  const stopped = () => me.web.events.some((e) => e.name === 'sync.stopped')

  await me.web.request('sync.start', { once: false })
  await until(t, 'the first announce', () => announces() === 1)
  const connections = seeder.connections

  // The association blocks the own key; the seeder drops the diary.
  const block = snapshot(mod, { seq: 1, blocked: [me.key] })
  seeder.push(block, { reject: me.key })
  await until(t, 'the blocking snapshot stored', async () => {
    const data = await readBlocklist(me.storage)
    return data !== null && data.snapshot.seq === 1
  })
  await until(t, 'the own-blocked warning', () => warningsOf(me.web).includes('aviso: sua identidade está bloqueada pela associação'))
  t.is(announces(), 1, 'not announced while blocked')
  t.absent(stopped(), 'the moderation drop does not end the continuous run')

  // Unblocked: announced again without reconnecting.
  seeder.push(snapshot(mod, { seq: 2, blocked: [] }))
  await until(t, 'the second announce', () => announces() === 2)
  t.is(seeder.connections, connections, 'on the same link')
  t.is((await readBlocklist(me.storage)).snapshot.seq, 2)
  t.absent(stopped(), 'still running')
  await me.web.request('sync.stop')
})

test('a snapshot adopted while the run is ending is still enforced before the result', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const target = await diary(t, certified(assoc, 'bloqueado tarde'))
  const A = hex(target.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [target] })
  const { web, storage } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key: A })
  let stopped = await onceRun(web)
  t.is(stopped.reason, 'done')
  t.alike(stopped.result.downloaded, { [A]: 3 })

  // The snapshot's save outlasts the run's deadline: it lands while the run
  // is ending.
  const writeJson = storage.writeJson
  storage.writeJson = async (key, value) => {
    if (key === 'blocklist') await new Promise((resolve) => setTimeout(resolve, 2500))
    return writeJson.call(storage, key, value)
  }
  const snap = snapshot(mod, { blocked: [A] })
  seeder.snapshot = snap
  stopped = await onceRun(web, 1500)
  storage.writeJson = writeJson
  t.comment(JSON.stringify(stopped.result.errors))
  t.alike(stopped.result.downloaded, {}, 'the blocked replica is not listed')
  t.alike(skippedOf(stopped.result), { [A]: 'blocked' })
  t.absent(await storage.hasCore('replica/' + A), 'purged')
  t.alike((await readBlocklist(storage)).snapshot, snap, 'the snapshot was stored')
})

test('log.read hides replicas from a revoked issuer, followed or not, and the sync run purges both', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer: issuerHex }, assoc.kp)
  const issued = (text) => [
    (key) => memberCertRecord(createIssuedCert({ member: key }, issuerKp, issuerCert)),
    () => postRecord({ text })
  ]
  const followed = await diary(t, issued('seguido'))
  const unfollowed = await diary(t, issued('deixado'))
  const A = hex(followed.key)
  const B = hex(unfollowed.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [followed, unfollowed] })
  const { web, storage } = await webNode(t, assoc, seeder.url)
  for (const key of [A, B]) await web.request('follow.add', { key })
  let stopped = await onceRun(web)
  t.is(stopped.reason, 'done')
  t.alike(stopped.result.downloaded, { [A]: 2, [B]: 2 })
  await web.request('follow.remove', { key: B })
  t.is((await web.request('log.read', { author: B })).entries.length, 2, 'an unfollowed replica reads')

  // The revocation is stored (as a run adopting it would) before any purge.
  const snap = snapshot(mod, { revokedIssuers: [issuerHex] })
  await writeBlocklist(storage, snap)
  for (const key of [A, B]) {
    t.ok(await storage.hasCore('replica/' + key), 'still stored')
    const err = await errorOf(web.request('log.read', { author: key }))
    t.is(err && err.code, 'NOT_FOUND')
    t.is(err && err.message, 'sem dados locais para este diário')
  }
  const feed = await web.request('feed.read', {})
  t.absent(feed.items.some((i) => i.author === A || i.author === B))

  // The next run purges the followed one and the unfollowed one.
  seeder.snapshot = snap
  stopped = await onceRun(web)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.alike(skippedOf(stopped.result), { [A]: 'revoked-issuer' })
  t.absent(await storage.hasCore('replica/' + A), 'the followed replica was purged')
  t.absent(await storage.hasCore('replica/' + B), 'the unfollowed replica was purged')
})

test('a once run waits for a newer snapshot the seeder advertises before ending', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const target = await diary(t, certified(assoc, 'bloqueado depois'))
  const A = hex(target.key)
  // The seeder's snapshot sends are spaced by 4 s (3200 + 3200 / 4): seq 2
  // is advertised at once but delivered about 4 s after seq 1, far later
  // than the other goals take.
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [target], blocklistMinIntervalMs: 3200 })
  const first = snapshot(mod, { seq: 1, blocked: [] })
  const second = snapshot(mod, { seq: 2, blocked: [A] })
  seeder.snapshot = first
  const storage = memoryNodeStorage()
  const saved = []
  const writeJson = storage.writeJson
  storage.writeJson = async (key, value) => {
    if (key === 'blocklist') {
      saved.push(value.snapshot.seq)
      if (value.snapshot.seq === 1) {
        // While seq 1 is being saved the seeder takes seq 2 and advertises
        // it: its have reaches the member before the seq 1 offer resolves.
        seeder.push(second)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    return writeJson.call(storage, key, value)
  }
  const { web } = await webNode(t, assoc, seeder.url, { storage, syncOptions: { blocklistMinIntervalMs: 0 } })
  await web.request('follow.add', { key: A })

  const stopped = await onceRun(web, 20000)
  const savedAtStop = saved.slice()
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.ok, true)
  t.alike(stopped.result.errors, [])
  t.alike(savedAtStop, [1, 2], 'the run ended only after seq 2 was offered and saved')
  t.is((await readBlocklist(storage)).snapshot.seq, 2, 'seq 2 stored')
  t.alike(skippedOf(stopped.result), { [A]: 'blocked' }, 'seq 2 enforced before the result')
  t.alike(stopped.result.downloaded, {})
  t.absent(await storage.hasCore('replica/' + A), 'purged')
})

test('a once run settles when the newest snapshot the seeder advertises is forged', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const other = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  seeder.snapshot = snapshot(moderator(other.kp), { seq: 1, blocked: ['ab'.repeat(32)] })
  const { web, storage } = await webNode(t, assoc, seeder.url, { syncOptions: { blocklistMinIntervalMs: 0 } })

  const stopped = await onceRun(web, 20000)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.ok, true, 'not held until the deadline')
  t.alike(stopped.result.errors, [])
  t.is(await readBlocklist(storage), null, 'refused: nothing stored')
})

test('a revocation adopted before block 0 reaches the replica is a moderation skip, not divergent data', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer: issuerHex }, assoc.kp)

  // The seeder's diary storage: once the member has opened its replica
  // (the quarantine verdict passed), every block read waits for release().
  let hold = false
  let release
  const released = new Promise((resolve) => { release = resolve })
  const base = memoryStorage()
  const wrapped = new WeakSet()
  const seederStorage = (name) => {
    const ram = base(name)
    if (name === 'data' && !wrapped.has(ram)) {
      wrapped.add(ram)
      const read = ram.read
      ram.read = function (offset, size, cb) {
        if (!hold) return read.call(ram, offset, size, cb)
        released.then(() => read.call(ram, offset, size, cb))
      }
    }
    return ram
  }
  const issued = await diary(t, [
    (key) => memberCertRecord(createIssuedCert({ member: key }, issuerKp, issuerCert)),
    () => postRecord({ text: 'certificado pelo emissor' })
  ], null, seederStorage)
  const A = hex(issued.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [issued] })

  const storage = memoryNodeStorage()
  let replicaOpened = false
  const core = storage.core
  storage.core = (name) => {
    if (name === 'replica/' + A) {
      replicaOpened = true
      hold = true
    }
    return core.call(storage, name)
  }
  const { web } = await webNode(t, assoc, seeder.url, { storage })
  await web.request('follow.add', { key: A })

  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 20000 })
  await until(t, 'the replica opened after the quarantine verdict', () => replicaOpened)
  // The revocation lands while block 0 is still held from the replica.
  seeder.push(snapshot(mod, { revokedIssuers: [issuerHex] }))
  await until(t, 'the revocation adopted', async () => (await readBlocklist(storage)) !== null)
  await new Promise((resolve) => setTimeout(resolve, 200))
  release()

  const stopped = await stoppedOf(web.events, runId)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(stopped))
  t.is(stopped.reason, 'done')
  t.absent(stopped.result.errors.some((e) => e.startsWith('bloco 0 divergente')), 'no divergent block 0 error')
  t.is(stopped.result.ok, true)
  t.alike(skippedOf(stopped.result), { [A]: 'revoked-issuer' })
  t.alike(stopped.result.downloaded, {})
  t.absent(await storage.hasCore('replica/' + A), 'the replica was purged')
})

test('cert.add and username.add honour the stored snapshot: a revoked issuer is refused, another still works', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const issuer = () => {
    const keyPair = crypto.keyPair()
    return { keyPair, hex: hex(keyPair.publicKey), cert: createIssuerCert({ issuer: hex(keyPair.publicKey) }, assoc.kp) }
  }
  const revoked = issuer()
  const good = issuer()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const { web, storage, key } = await webNode(t, assoc, seeder.url, { write: false })
  await writeBlocklist(storage, snapshot(mod, { revokedIssuers: [revoked.hex] }))

  const before = await web.request('log.read', {})
  const certErr = await errorOf(web.request('cert.add', { cert: createIssuedCert({ member: key }, revoked.keyPair, revoked.cert) }))
  t.is(certErr && certErr.message, 'certificado inválido (revoked-issuer)')
  t.alike(await web.request('log.read', {}), before, 'nothing appended')

  // A certificate from an issuer that is not revoked works.
  t.alike(await web.request('cert.add', { cert: createIssuedCert({ member: key }, good.keyPair, good.cert) }), { seq: 0 })

  const refused = await errorOf(web.request('username.add', { record: createUsernameRecord({ member: key, username: 'ana' }, revoked.keyPair, revoked.cert) }))
  t.alike([refused && refused.code, refused && refused.message], ['USAGE', 'registro de nome inválido'])
  t.is((await web.request('log.read', {})).entries.length, 1, 'no username block appended')

  const added = await web.request('username.add', { record: createUsernameRecord({ member: key, username: 'ana' }, good.keyPair, good.cert) })
  t.is(added.changed, true)
  t.is((await web.request('log.read', {})).entries.length, 2)
})
