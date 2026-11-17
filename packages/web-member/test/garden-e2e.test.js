'use strict'

// Varandinha end to end (docs/rpc.md 5.157 to 5.166): the real Seeder behind
// startSeedWs (the WebSocket entry and the /index/garden routes) and real
// browser nodes (lib/node.js over in-memory storage) on the local DHT, tmp
// dirs only. The helper's seeder index reads go through a fetchMedia seam
// that forwards to the real route, or makes the answer lie or vanish, to
// show the help and give checks failing closed. Every refusal writes nothing.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { Seeder } = require('@varanda/core/lib/seeder')
const { garden } = require('@varanda/rpc')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
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
  return { current: seeder, publicKey, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
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

// The offset from the real clock to the next Brasília Saturday 00:30
// (03:30Z): the Barraquinha opens on Saturdays only.
function saturdayOffset () {
  const real = Date.now()
  const d = new Date(real)
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 30)
  while (at <= real || !garden.stallDay(at)) at += 24 * HOUR
  return at - real
}

async function mimosIndex (host, key) {
  try {
    const res = await fetch('http://127.0.0.1:' + host.port + '/index/garden/' + key + '/mimos', { cache: 'no-store' })
    if (res.status !== 200) return null
    return await res.json()
  } catch {
    return null
  }
}

// Waits until the seeder's Barraquinha index of `n` is caught up and passes
// `ok`; -> that answer.
async function stallIndexed (host, n, ok) {
  let body = null
  await until(async () => {
    body = await mimosIndex(host, n.key)
    return body !== null && body.indexing === false && ok(body)
  }, { name: 'mimos index', timeoutMs: 60000, intervalMs: 300 })
  return body
}

// A page diary (a page-roster at block 1), served whole by the seeder.
async function servedPage (t, assoc, host) {
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const ownerKp = crypto.keyPair()
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  const fields = { page: m.key, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: new Date(Date.now()).toISOString(), nonce: 'r'.repeat(43), association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuerKp, issuerCert))
  const link = connectSeeder({ member: m, socket: new WebSocket(host.url), association: assoc.hex, seederPublicKey: host.publicKey, timeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
  return { key: m.key }
}

const has = (rows, row) => rows.some((r) => Object.keys(row).every((k) => r[k] === row[k]))

test('barraquinha end to end: decor, give a ripe pot on a Saturday, take with the index down, drop and take again, refusals, fail closed', async (t) => {
  t.timeout(600000)
  // Every node and the seeder share the shifted clock from their creation
  // to their close, so no clock-based state straddles a jump but the one
  // forward ripening step. The restore is the last teardown, and waits out the
  // deletion roster probe (ROSTER_PROBE_MS, 2 s in core/lib/deletion.js): a
  // probe started before the close polls until its shifted deadline, which
  // the real clock would only reach days later.
  const realNow = Date.now
  let shift = saturdayOffset()
  Date.now = () => realNow() + shift
  t.teardown(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    Date.now = realNow
  }, { order: 1, force: true })

  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederStack(t, bootstrap, assoc)
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  const C = await memberNode(t, assoc, host)
  const P = await servedPage(t, assoc, host)
  const stranger = hex(crypto.randomBytes(32))

  t.alike(await A.web.request('garden.stall', {}), { open: true, decor: null, giftsToday: 0, takesToday: 0, gave: [], takes: [] }, 'a Saturday, nothing yet')
  t.alike(await refusal(t, A, 'garden.decor', { items: ['gato'] }), ['USAGE', 'ligue a Varandinha para jogar'], 'decor needs the flag')
  t.alike(await A.web.request('garden.set', { on: true }), { on: true })
  t.alike(await B.web.request('garden.set', { on: true }), { on: true })
  const planted = await A.web.request('garden.play', { acts: [{ op: 'plant', pot: 0, plant: 'manjericao' }] })
  for (const key of [B.key, C.key, P.key]) await A.web.request('follow.add', { key })
  t.is((await A.web.request('log.read', {})).entries.filter((e) => e.record.type === 'follow').length, 3, 'the follows in A\'s diary')
  t.alike(await refusal(t, A, 'garden.give', { to: B.key, pot: 0 }), ['USAGE', 'este vaso ainda não está pronto'], 'not ripe yet')
  await push(t, A, host)
  await push(t, B, host)
  await indexed(host, B, (b) => b.on !== null)
  await indexed(host, C, (b) => b.on === null)

  // Saturday 07:30: the manjericão is ripe. The clock only moves forward
  // and stays there: a probe or deadline taken inside the step would
  // otherwise wait hours once the clock came back.
  shift += 7 * HOUR
  await A.web.request('sync.start', {})
  await B.web.request('sync.start', {})

  // Refused on the chain, before any index read.
  t.alike(await refusal(t, A, 'garden.give', { to: A.key, pot: 0 }), ['USAGE', 'não dá para dar um mimo para si'], 'self')
  await A.web.request('block.set', { key: stranger, on: true })
  t.alike(await refusal(t, A, 'garden.give', { to: stranger, pot: 0 }), ['USAGE', 'você bloqueou esta pessoa'], 'blocked')
  await A.web.request('block.set', { key: stranger, on: false })
  t.alike(await refusal(t, A, 'garden.give', { to: stranger, pot: 0 }), ['USAGE', 'você só dá mimos para quem você segue'], 'not followed')
  t.alike(await refusal(t, A, 'garden.give', { to: B.key, pot: 1 }), ['USAGE', 'este vaso ainda não está pronto'], 'an empty pot')

  // The recipient's balcony, read off the chain; fail closed.
  t.alike(await refusal(t, A, 'garden.give', { to: P.key, pot: 0 }), ['USAGE', 'páginas não têm Varandinha'], 'a page')
  t.alike(await refusal(t, A, 'garden.give', { to: C.key, pot: 0 }), ['USAGE', 'esta pessoa não está na Varandinha'], 'C never opted in')
  for (const mode of ['dead', 'indexing']) {
    A.index.mode = mode
    t.alike(await refusal(t, A, 'garden.give', { to: B.key, pot: 0 }), UNAVAILABLE, 'index ' + mode)
  }
  A.index.mode = 'real'

  // Enfeites, latest wins.
  const decor = await A.web.request('garden.decor', { items: ['gato'] })
  t.alike([decor.ref, decor.items], [A.key + ':' + decor.seq, ['gato']])
  const decor2 = await A.web.request('garden.decor', { items: ['rede', 'pisca'] })
  t.alike(decor2.items, ['rede', 'pisca'])

  // The give: the gift and the emptied pot in one append.
  const gift = await A.web.request('garden.give', { to: B.key, pot: 0 })
  t.is(gift.ref, A.key + ':' + gift.seq)
  t.is(gift.state.seq, gift.seq - 1, 'the state right before the gift')
  t.alike(gift.state.pots, [null, null, null, null, null, null], 'the pot is empty')
  t.is(gift.state.n, planted.state.n + 1, 'one save spent')
  const own = await A.web.request('garden.state', {})
  t.alike(own.state, gift.state, 'garden.state shows the pot empty')
  const log = (await A.web.request('log.read', {})).entries
  const giftRecord = log.find((e) => e.seq === gift.seq).record
  t.alike([giftRecord.type, giftRecord.to, giftRecord.item], ['garden-gift', B.key, 'manjericao'])
  t.alike(await A.web.request('garden.stall', {}), {
    open: true,
    decor: { seq: decor2.seq, items: ['rede', 'pisca'] },
    giftsToday: 1,
    takesToday: 0,
    gave: [{ seq: gift.seq, to: B.key, item: 'manjericao', at: giftRecord.at }],
    takes: []
  })
  t.alike(await refusal(t, A, 'garden.give', { to: B.key, pot: 0 }), ['USAGE', 'você já deu um mimo para esta pessoa hoje'], 'one gift per person per day')
  let stall = await stallIndexed(host, A, (b) => b.decor === decor2.seq)
  t.alike([stall.pending, stall.shelf], [[], []], 'A has no mimos')
  stall = await stallIndexed(host, B, (b) => has(b.pending, { author: A.key, seq: gift.seq }))
  t.alike(stall.shelf, [], 'pending, not on the shelf')

  // Refused before the peek.
  t.alike(await refusal(t, B, 'garden.take', { from: B.key, seq: gift.seq }), ['USAGE', 'este mimo não está mais disponível'], 'self')
  await B.web.request('block.set', { key: A.key, on: true })
  t.alike(await refusal(t, B, 'garden.take', { from: A.key, seq: gift.seq }), ['USAGE', 'você bloqueou esta pessoa'], 'a blocked giver')
  await B.web.request('block.set', { key: A.key, on: false })
  t.alike(await refusal(t, B, 'garden.take', { from: A.key, seq: decor2.seq }), ['USAGE', 'este mimo não está mais disponível'], 'a block that is no gift')

  // The take reads no index: it goes through with every /index/garden/ read failing.
  B.index.mode = 'dead'
  const take = await B.web.request('garden.take', { from: A.key, seq: gift.seq })
  t.alike([take.ref, take.changed], [B.key + ':' + take.seq, true])
  const again = await B.web.request('garden.take', { from: A.key, seq: gift.seq })
  t.alike(again, { ...take, changed: false }, 'a second take answers the first and writes nothing')
  B.index.mode = 'real'
  const bLog = (await B.web.request('log.read', {})).entries
  const takeRecord = bLog.find((e) => e.seq === take.seq).record
  t.alike([takeRecord.type, takeRecord.from, takeRecord.seq], ['garden-take', A.key, gift.seq])
  t.alike(await B.web.request('garden.stall', {}), {
    open: true,
    decor: null,
    giftsToday: 0,
    takesToday: 1,
    gave: [],
    takes: [{ seq: take.seq, from: A.key, gseq: gift.seq, at: takeRecord.at }]
  })
  stall = await stallIndexed(host, B, (b) => has(b.shelf, { seq: take.seq }))
  t.alike(stall.shelf, [{ seq: take.seq, from: A.key, gseq: gift.seq }], 'on the shelf')
  t.absent(has(stall.pending, { author: A.key, seq: gift.seq }), 'and no longer pending')

  // Dropping the take puts the gift back in pending; taking again.
  t.alike(await refusal(t, B, 'garden.drop', { kind: 'gift', seq: take.seq }), ['USAGE', 'este registro não é um mimo seu'], 'a take is not a gift')
  const dropped = await B.web.request('garden.drop', { kind: 'take', seq: take.seq })
  t.alike(dropped.deleted, [take.seq])
  t.is((await B.web.request('garden.stall', {})).takes.length, 0)
  stall = await stallIndexed(host, B, (b) => b.shelf.length === 0 && has(b.pending, { author: A.key, seq: gift.seq }))
  t.pass('pending again')
  const retake = await B.web.request('garden.take', { from: A.key, seq: gift.seq })
  t.ok(retake.changed && retake.seq > dropped.seq, 'a new take')
  await stallIndexed(host, B, (b) => has(b.shelf, { seq: retake.seq, from: A.key, gseq: gift.seq }))
  t.pass('on the shelf again')

  // The giver drops the gift: it leaves the shelf.
  const gone = await A.web.request('garden.drop', { kind: 'gift', seq: gift.seq })
  t.alike(gone.deleted, [gift.seq])
  t.alike((await A.web.request('garden.stall', {})).gave, [])
  stall = await stallIndexed(host, B, (b) => b.shelf.length === 0)
  t.alike(stall.pending, [], 'neither on the shelf nor pending')

  // With the seeder stopped (and B's run past its link) the take cannot
  // read the gift: unavailable, nothing written, never a refusal that
  // claims the gift gone.
  t.alike((await B.web.request('garden.drop', { kind: 'take', seq: retake.seq })).deleted, [retake.seq])
  await host.current.close()
  await until(async () => (await errorOf(B.web.request('diary.peek', { author: A.key, seqs: [gift.seq] }))) !== null, { name: 'link gone', timeoutMs: 60000, intervalMs: 300 })
  t.alike(await refusal(t, B, 'garden.take', { from: A.key, seq: gift.seq }), UNAVAILABLE, 'seeder stopped')
})
