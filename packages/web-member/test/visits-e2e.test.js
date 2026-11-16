'use strict'

// Visitas end to end: the real Seeder with the dm option (its dm and visit
// pools on disk, the stamp channel with a test postage key generated here)
// behind startSeedWs (the WebSocket entry and the /index routes), and real
// browser nodes (lib/node.js over in-memory storage). The ping delay is
// injected (0). Local DHT and tmp dirs only.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { Seeder } = require('@varanda/core/lib/seeder')
const dmCore = require('@varanda/core/lib/dm')
const gc = require('@varanda/core/lib/group-crypto')
const visits = require('@varanda/core/lib/visits')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmLocalKeyFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { hex, rsaKey, push, wallet, takeStamps } = require('./helpers/dm-e2e')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')

function noop () {}

async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-visits-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-visits-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const key = rsaKey()
  const seeder = new Seeder({
    dataDir,
    associationKey: assoc.hex,
    ...localSwarmOptions(bootstrap),
    log: noop,
    dm: { postage: { get: async () => ({ keys: [key] }) } }
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { current: seeder, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// A member node with the dm keys, pushed and its wallet full. No top-up
// after the first fill (the budget case counts the stamps).
async function memberNode (t, assoc, host) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: host.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, dm: { topUpRetryMs: 100, topUpEveryMs: 3600000, visitDelay: () => 0 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  const n = { node, web, storage, key: publicKey, keyPair, prf }
  await push(t, n, host)
  await web.request('dm.enable')
  await push(t, n, host)
  await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET, { name: 'wallet', timeoutMs: 60000 })
  return n
}

// Puts stamps taken by takeStamps back into the node's sealed wallet.
async function giveBack (n, stamps) {
  const key = await dmLocalKeyFromPrf(n.prf)
  const w = await store.readDmStamps(n.storage)
  const items = [...w.items, ...stamps.map((s) => ({ kid: s.kid, ...gc.sealRecord({ token: s.token, sig: s.sig }, key) }))]
  await store.writeDmStamps(n.storage, { items, kids: w.kids })
}

async function profileVisits (host, key) {
  try {
    const res = await fetch('http://127.0.0.1:' + host.port + '/index/profile/' + key, { cache: 'no-store' })
    if (res.status !== 200) return undefined
    return (await res.json()).visits
  } catch {
    return undefined
  }
}

// Sets the switch and waits until the seeder's profile index points at the
// new block.
async function setVisits (t, host, n, on) {
  const before = await profileVisits(host, n.key)
  t.alike(await n.web.request('visits.set', { on }), { on })
  await until(async () => {
    const seq = await profileVisits(host, n.key)
    if (Number.isSafeInteger(seq) && seq !== before) return true
    // A node with a continuous run pushes on its own.
    if (!n.running) await push(t, n, host)
    return false
  }, { name: 'profile index', timeoutMs: 60000, intervalMs: 300 })
}

async function visitorsOf (n) {
  await n.web.request('dm.pull').catch(noop)
  return (await n.web.request('visits.list', {})).visits
}

test('visitas end to end: both on, sender off, receiver off, budget, off clears the list', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederStack(t, bootstrap, assoc)
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  const C = await memberNode(t, assoc, host)
  // The sender's peeks are served by its running sync.
  await A.web.request('sync.start', {})
  A.running = true
  const today = visits.visitDay(Date.now())

  // Sender off: nothing queued.
  t.alike(await A.web.request('visits.state', {}), { on: false, sentToday: 0 })
  t.alike(await A.web.request('visits.note', { key: B.key }), { queued: false }, 'sender off')
  t.alike(await A.web.request('visits.list', {}), { visits: [] })

  await setVisits(t, host, A, true)
  await setVisits(t, host, B, true)
  t.alike(await A.web.request('visits.state', {}), { on: true, sentToday: 0 })
  t.alike(await A.web.request('visits.set', { on: true }), { on: true }, 'the same state again')

  // Receiver off: C never turned it on.
  t.alike(await A.web.request('visits.note', { key: C.key }), { queued: false }, 'receiver off')
  t.alike(await A.web.request('visits.note', { key: A.key }), { queued: false }, 'never to self')

  // Budget: the last VISIT_STAMP_RESERVE stamps are never spent.
  const size = await wallet(A.storage)
  const taken = await takeStamps(A, size - visits.VISIT_STAMP_RESERVE)
  t.alike(await A.web.request('visits.note', { key: B.key }), { queued: false }, 'only the reserve left')
  await giveBack(A, taken)

  // Both on: queued, sent on the visit lane, filed by B.
  t.alike(await A.web.request('visits.note', { key: B.key }), { queued: true })
  t.is((await A.web.request('visits.state', {})).sentToday, 1)
  await until(async () => (await visitorsOf(B)).length === 1, { name: 'B files the visit', timeoutMs: 60000, intervalMs: 300 })
  t.alike(await B.web.request('visits.list', {}), { visits: [{ key: A.key, at: visits.dayMs(today) }] })
  t.alike(await A.web.request('visits.note', { key: B.key }), { queued: false }, 'the same person again this week')
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'a ping is no message')
  t.alike(await visitorsOf(A), [], 'no self copy: the sender files nothing')

  // C turns it on: now it takes pings.
  await setVisits(t, host, C, true)
  t.alike(await A.web.request('visits.note', { key: C.key }), { queued: true }, 'receiver on')
  await until(async () => (await visitorsOf(C)).length === 1, { name: 'C files the visit', timeoutMs: 60000, intervalMs: 300 })

  // visits.clear empties the list; a pull files nothing again.
  t.alike(await C.web.request('visits.clear', {}), { ok: true })
  t.alike(await visitorsOf(C), [], 'cleared, and nothing comes back')

  // Off clears the list at once, and an off member sends nothing.
  await setVisits(t, host, B, false)
  t.alike(await B.web.request('visits.list', {}), { visits: [] })
  t.alike(await B.web.request('visits.state', {}), { on: false, sentToday: 0 })
  t.alike(await B.web.request('visits.note', { key: A.key }), { queued: false })
  t.is(await B.storage.readJson('dmVisits'), null, 'the list is gone from kv')
  // Turned on again the same day, the old ping is not filed again.
  await setVisits(t, host, B, true)
  t.alike(await visitorsOf(B), [])
})

test('visits.set refuses to turn on without private messages enabled', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederStack(t, bootstrap, assoc)
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: host.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  await t.exception(() => web.request('visits.set', { on: true }), /Ative as mensagens privadas para registrar visitas\./)
  t.alike(await web.request('visits.state', {}), { on: false, sentToday: 0 }, 'nothing written')
  t.alike(await web.request('visits.set', { on: false }), { on: false }, 'turning off needs no dm key')
})
