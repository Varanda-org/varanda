'use strict'

// Varandinha end to end (docs/rpc.md 5.157 to 5.160): the real Seeder behind
// startSeedWs (the WebSocket entry and the /index/garden route) and real
// browser nodes (lib/node.js over in-memory storage) on the local DHT, tmp
// dirs only. The helper's seeder index reads go through a fetchMedia seam
// that forwards to the real route, or makes the answer lie or vanish, to
// show the help check failing closed. Every refusal writes nothing.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { Seeder } = require('@varanda/core/lib/seeder')
const { garden } = require('@varanda/rpc')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { hex, push } = require('./helpers/dm-e2e')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')

const UNAVAILABLE = ['NOT_FOUND', 'semeador indisponível']
const HOUR = 3600000

function noop () {}

async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-garden-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-garden-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, associationKey: assoc.hex, ...localSwarmOptions(bootstrap), log: noop })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { current: seeder, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// A certified member node, pushed. index.mode steers its seeder index reads
// of /index/garden/: 'real' forwards, 'swap' exchanges the on and state
// pointers, 'indexing' marks the answer as still indexing, 'dead' fails the
// request.
async function memberNode (t, assoc, host) {
  const index = { mode: 'real' }
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: host.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    writeGate: false,
    fetchMedia: async (url, opts) => {
      if (!String(url).includes('/index/garden/') || index.mode === 'real') return fetch(url, opts)
      if (index.mode === 'dead') throw new Error('rede indisponível')
      const body = await (await fetch(url, opts)).json()
      if (index.mode === 'swap') [body.on, body.state] = [body.state, body.on]
      if (index.mode === 'indexing') body.indexing = true
      return new Response(JSON.stringify(body), { status: 200 })
    }
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  const n = { node, web, key: publicKey, index }
  await push(t, n, host)
  return n
}

async function gardenIndex (host, key) {
  try {
    const res = await fetch('http://127.0.0.1:' + host.port + '/index/garden/' + key, { cache: 'no-store' })
    if (res.status !== 200) return null
    return await res.json()
  } catch {
    return null
  }
}

// Waits until the seeder's garden index of `n` is caught up and passes `ok`.
async function indexed (host, n, ok) {
  await until(async () => {
    const body = await gardenIndex(host, n.key)
    return body !== null && body.indexing === false && ok(body)
  }, { name: 'garden index', timeoutMs: 60000, intervalMs: 300 })
}

// The own diary is dense (seq = position): its length from one log.read.
async function lengthOf (n) {
  const r = await n.web.request('log.read', {})
  return r.entriesTruncated + r.entries.length + r.invalid.length
}

// The refusal [code, message] of a call that must write nothing.
async function refusal (t, n, method, params) {
  const before = await lengthOf(n)
  const err = await errorOf(n.web.request(method, params))
  t.is(await lengthOf(n), before, method + ' wrote nothing')
  return [err && err.code, err && err.message]
}

// Runs fn with Date.now moved `ms` ahead (every node here shares the clock).
async function later (ms, fn) {
  const realNow = Date.now
  Date.now = () => realNow() + ms
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

test('varandinha end to end: opt in, play, help a followed balcony, refusals, fail closed, water at hour 3, leave', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederStack(t, bootstrap, assoc)
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  const C = await memberNode(t, assoc, host)
  const D = await memberNode(t, assoc, host)

  // A opts in once and plants manjericão in pot 0.
  t.alike(await A.web.request('garden.state', {}), { on: false, state: null, savesToday: 0, helpsToday: 0, given: [] })
  t.alike(await A.web.request('garden.set', { on: true }), { on: true })
  const afterOn = await lengthOf(A)
  t.alike(await A.web.request('garden.set', { on: true }), { on: true }, 'already on')
  t.is(await lengthOf(A), afterOn, 'a second opt in writes nothing')
  const planted = await A.web.request('garden.play', { acts: [{ op: 'plant', pot: 0, plant: 'manjericao' }] })
  t.is(planted.ref, A.key + ':' + planted.seq)
  t.is(planted.state.seq, planted.seq)
  t.is(planted.state.n, 1)
  t.is(planted.state.pots[0].plant, 'manjericao')
  t.alike(planted.state.pots.slice(1), [null, null, null, null, null])
  const own = await A.web.request('garden.state', {})
  t.is(own.on, true)
  t.alike(own.state, planted.state, 'the saved state')
  t.is(own.savesToday, 1)
  await push(t, A, host)
  await indexed(host, A, (b) => b.state === planted.seq && b.on !== null)
  await indexed(host, C, (b) => b.on === null)

  // B follows A and C (drained into B's diary by the next request).
  await B.web.request('follow.add', { key: A.key })
  await B.web.request('follow.add', { key: C.key })
  t.ok((await B.web.request('log.read', {})).entries.filter((e) => e.record.type === 'follow').length === 2, 'both follows in B\'s diary')

  // Refused on the chain, before any index read.
  t.alike(await refusal(t, B, 'garden.help', { to: A.key, pot: 0 }), ['USAGE', 'ligue a Varandinha para regar'], 'own flag off')
  t.alike(await refusal(t, B, 'garden.help', { to: B.key, pot: 0 }), ['USAGE', 'não dá para regar a própria varanda'], 'self')
  t.alike(await B.web.request('garden.set', { on: true }), { on: true })
  t.alike(await D.web.request('garden.set', { on: true }), { on: true })
  t.alike(await refusal(t, D, 'garden.help', { to: A.key, pot: 0 }), ['USAGE', 'você só rega a varanda de quem você segue'], 'D does not follow A')

  // The owner's balcony, read off the chain through B's running sync.
  await B.web.request('sync.start', {})
  t.alike(await refusal(t, B, 'garden.help', { to: C.key, pot: 0 }), ['USAGE', 'esta pessoa não está na Varandinha'], 'C never opted in')
  t.alike(await refusal(t, B, 'garden.help', { to: A.key, pot: 3 }), ['USAGE', 'este vaso não tem planta para regar'], 'an empty pot')

  // Fail closed: a lying or missing index answer writes nothing.
  for (const mode of ['swap', 'indexing', 'dead']) {
    B.index.mode = mode
    t.alike(await refusal(t, B, 'garden.help', { to: A.key, pot: 0 }), UNAVAILABLE, 'index ' + mode)
  }
  B.index.mode = 'real'

  const helped = await B.web.request('garden.help', { to: A.key, pot: 0 })
  t.is(helped.ref, B.key + ':' + helped.seq)
  const written = (await B.web.request('log.read', {})).entries.find((e) => e.seq === helped.seq)
  t.alike([written.record.type, written.record.to, written.record.pot], ['garden-help', A.key, 0])
  t.alike(await refusal(t, B, 'garden.help', { to: A.key, pot: 0 }), ['USAGE', 'você já regou esta varanda hoje'], 'the same balcony the same day')
  const mine = await B.web.request('garden.state', {})
  t.is(mine.helpsToday, 1)
  t.alike(mine.given, [{ seq: helped.seq, to: A.key, pot: 0, at: written.record.at }])

  // Hour 3: the manjericão takes water (the node clock moved ahead).
  const watered = await later(garden.GARDEN_WATER_GAP_MS + 60000, () => A.web.request('garden.play', { acts: [{ op: 'water', pot: 0 }] }))
  t.is(watered.state.pots[0].w, 1, 'watered once')
  t.is(watered.state.pots[0].water, watered.state.at)
  t.ok(Date.parse(watered.state.at) - Date.parse(planted.state.at) >= 3 * HOUR)

  // Leaving tombstones the states and helps and writes the off flag last;
  // a second leave writes nothing.
  t.alike(await A.web.request('garden.set', { on: false }), { on: false })
  const left = await A.web.request('garden.state', {})
  t.alike([left.on, left.state, left.given], [false, null, []])
  const afterLeave = await lengthOf(A)
  t.alike(await A.web.request('garden.set', { on: false }), { on: false })
  t.is(await lengthOf(A), afterLeave, 'a second leave writes nothing')

  t.alike(await B.web.request('garden.set', { on: false }), { on: false })
  const gone = await B.web.request('garden.state', {})
  t.alike([gone.on, gone.helpsToday, gone.given], [false, 0, []], 'the helper\'s help is withdrawn with the leave')
})
