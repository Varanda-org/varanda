// The bounded Espiadinha (lib/peek.js over 'varanda/discovery/1'), loopback
// only: a REAL in-process Seeder behind startSeedWs holding 120 certified
// Hypercore 10 diaries (each: cert, profile, an older post at seq 2 and a
// newer one at seq 3), plus one diary holding only its cert. Built once for
// the whole file. The reader follows two diaries, blocks one through its
// stored blocklist and owns one (fetched as cover, never shown).
//
// Candidate pages are the seeder's own (discoveryPage) or, for the hostile
// cases, a stand-in page function installed on the same seeder, so every
// answer still goes through the seeder's discovery channel and every block
// through its replication.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { profileRecord, postRecord } = require('@varanda/core/lib/records')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { DISCOVERY_PACE_MS } = require('@varanda/core/lib/discovery-net')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { memoryNodeStorage } = require('../lib/node-storage')
const { writeBlocklist, writeFollows } = require('../lib/node-store')
const { createPeeker } = require('../lib/peek')

const DIARIES = 120
const MINUTE = 60000
const OWN = 5
const FOLLOWED = [10, 20]
const BLOCKED = 30
const VIEW = 'ab'.repeat(16)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

async function pool (items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

// One teardown bag for the fixture shared by every test of the file; the
// last test runs it.
const bag = { fns: [], teardown (fn, { order = 0 } = {}) { this.fns.push({ fn, order }) } }
async function closeBag () {
  const fns = bag.fns.splice(0).sort((a, b) => a.order - b.order)
  for (const { fn } of fns) {
    try { await fn() } catch {}
  }
}

let fixture = null

async function getFixture () {
  if (fixture !== null) return fixture
  const { bootstrap } = await testnet(bag)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const dataDir = tmpDir(bag, 'varanda-bounded-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(bag, 'varanda-bounded-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), discoveryRebuildMs: 50, log: (e) => events.push(e) })
  bag.teardown(() => seeder.close())
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  bag.teardown(() => ws.close())
  const url = 'ws://127.0.0.1:' + ws.port + '/seeder'

  // Diary i: newest post at now - (i + 1) min, older one at now - (1000 + i) min.
  const now = Date.now()
  const members = await pool(Array.from({ length: DIARIES + 1 }, (_, i) => i), 8, async (i) => {
    const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
    bag.teardown(() => m.close())
    await m.setCert(createCert({ member: m.key }, assoc.kp))
    if (i < DIARIES) {
      await m.core.append(profileRecord({ name: 'membro ' + i, bio: '' }))
      await m.core.append(postRecord({ text: 'velho ' + i, at: new Date(now - (1000 + i) * MINUTE).toISOString() }))
      await m.core.append(postRecord({ text: 'novo ' + i, at: new Date(now - (i + 1) * MINUTE).toISOString() }))
    }
    const link = connectSeeder({ member: m, socket: new WebSocket(url), association: assoc.hex, seederPublicKey: publicKey, timeoutMs: 60000 })
    try {
      await link.admitted
      await link.waitServed(m.core.length)
    } finally {
      link.close()
    }
    return m
  })
  const keys = members.slice(0, DIARIES).map((m) => m.key)
  const short = members[DIARIES].key

  // The seeder's discovery view lists every diary, newest post first, once
  // its index scan has read them all.
  const original = seeder.discoveryPage.bind(seeder)
  await until(() => {
    const out = []
    let after = null
    let view = null
    for (let i = 0; i < 10; i++) {
      const p = original({ after, limit: 64, view })
      if (p.stale) return false
      view = p.view
      out.push(...p.items.map((it) => it.key))
      if (p.next === null) break
      after = p.next
    }
    return out.length === keys.length && out.every((k, i) => k === keys[i])
  }, { timeoutMs: 60000, name: 'discovery view in post order' })

  const keyPair = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(keyPair.publicKey) }, assoc.kp)
  const blocklist = createSnapshot({ seq: 1, blocked: [keys[BLOCKED]], revokedIssuers: [] }, keyPair, modCert)

  // What every traversal must show: each visible diary's newest post (round
  // 0), then its older one (round 1), newest first.
  const hiddenIdx = new Set([OWN, BLOCKED, ...FOLLOWED])
  const shown = keys.filter((_, i) => !hiddenIdx.has(i))
  const expected = [...shown.map((k) => k + ':3'), ...shown.map((k) => k + ':2')]
  fixture = { assoc, seeder, events, url, keys, short, original, blocklist, expected }
  return fixture
}

async function readerStorage (fx, follows = FOLLOWED.map((i) => fx.keys[i])) {
  const storage = memoryNodeStorage()
  await writeFollows(storage, follows)
  await writeBlocklist(storage, fx.blocklist)
  return storage
}

// A peeker as the reader. `createSocket` defaults to a plain WebSocket;
// `events` collects every trace event.
function peeker (t, fx, storage, { limits = {}, createSocket = null, events = [] } = {}) {
  const p = createPeeker({
    ownKey: async () => fx.keys[OWN],
    storage,
    association: fx.assoc.hex,
    seederUrl: fx.url,
    createSocket: createSocket || ((u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    }),
    limits: { ...limits, trace: (ev) => events.push(ev) }
  })
  t.teardown(() => p.close(), { force: true })
  return p
}

function rows (page) {
  return page.items.map((it) => it.author + ':' + it.seq)
}

// First page, then continuations until next is null. -> the pages.
async function allPages (p, limit, max = 60) {
  const pages = [await p.read({ limit })]
  while (pages[pages.length - 1].next !== null && pages.length < max) {
    pages.push(await p.read({ limit, after: pages[pages.length - 1].next }))
  }
  return pages
}

function dropped (events) {
  return events.filter((e) => e.event === 'peer-dropped' && (e.reason === 'message-rate' || e.reason === 'discovery-request-cap' || e.reason === 'discovery'))
}

// A stand-in page function over a fixed list of { key, length } (repeats
// allowed across pages), one view, cursor t = index of the last item.
function listPages (list) {
  return ({ after = null, limit, view = null }) => {
    if (view !== null && view !== VIEW) return { stale: true }
    const start = after === null ? 0 : after.t + 1
    const items = list.slice(start, start + limit)
    const end = start + items.length
    const next = end < list.length ? { t: end - 1, h: '0'.repeat(64) } : null
    return { view: VIEW, items, next, total: list.length }
  }
}

// A WebSocket whose inbound messages are dropped while gate.hold is true (a
// stalled seeder), as ws-stream.js consumes it.
function holdingSocket (u, gate) {
  const ws = new WebSocket(u)
  ws.on('error', noop)
  const wrapped = new Map()
  return {
    get readyState () { return ws.readyState },
    get binaryType () { return ws.binaryType },
    set binaryType (v) { ws.binaryType = v },
    send: (d) => ws.send(d),
    close: (...args) => ws.close(...args),
    addEventListener (type, fn) {
      if (type !== 'message') return ws.addEventListener(type, fn)
      const w = (ev) => { if (!gate.hold) fn(ev) }
      wrapped.set(fn, w)
      ws.addEventListener('message', w)
    },
    removeEventListener (type, fn) {
      ws.removeEventListener(type, wrapped.get(fn) || fn)
    }
  }
}

test('bounded: the first page fetches blocks of at most 48 diaries; paging to the end shows every newest post once, then round 2; the own diary is fetched and hidden', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  const trace = []
  const p = peeker(t, fx, await readerStorage(fx), { events: trace })
  const first = await p.read({ limit: 10 })
  const firstGets = new Set(trace.filter((e) => e.type === 'get' && e.seq === 0).map((e) => e.key))
  t.ok(firstGets.size <= 48, 'the first page fetched block 0 of ' + firstGets.size + ' diaries')
  t.ok(firstGets.has(fx.keys[OWN]), 'the own diary is fetched as cover')
  t.is(trace.filter((e) => e.type === 'candidates').length, 1, 'one candidate page')
  t.alike(rows(first), fx.expected.slice(0, 9), 'the first ten slots, the own one hidden')
  t.is(first.incomplete, false)
  t.ok(first.diaries <= 48, 'diaries counts the candidates loaded so far (' + first.diaries + ')')

  const pages = [first]
  while (pages[pages.length - 1].next !== null && pages.length < 60) {
    pages.push(await p.read({ limit: 20, after: pages[pages.length - 1].next }))
  }
  const all = pages.flatMap(rows)
  t.alike(all, fx.expected, 'every visible newest post once, newest first, then round 2')
  t.is(new Set(all).size, all.length, 'no row twice')
  t.absent(all.some((r) => r.startsWith(fx.keys[OWN])), 'the own diary is never shown')
  t.ok(pages.every((pg) => pg.incomplete === false), 'every page complete')
  t.is(pages[pages.length - 1].diaries, DIARIES - 1 - FOLLOWED.length - 1, 'every candidate loaded by the end')
  t.alike(dropped(fx.events), [], 'the seeder never dropped the reader')
})

test('v1: a seeder with discovery off gives the same pages as the rule, with 3 blocks in flight or 1', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  fx.seeder.discovery = false
  t.teardown(() => { fx.seeder.discovery = true })
  const trace = []
  const p = peeker(t, fx, await readerStorage(fx), { events: trace })
  const pages = await allPages(p, 25)
  t.is(trace.filter((e) => e.type === 'candidates').length, 0, 'no candidate page on a v1 link')
  t.is(new Set(trace.filter((e) => e.type === 'get' && e.seq === 0).map((e) => e.key)).size, DIARIES - FOLLOWED.length - 1, 'the whole inventory is fetched on the first page, as before')
  t.is(pages[0].diaries, DIARIES - 1 - FOLLOWED.length - 1, 'every candidate from the first page')
  const serial = peeker(t, fx, await readerStorage(fx), { limits: { windowInflight: 1 } })
  const serialPages = await allPages(serial, 25)
  t.alike(pages.map(rows), serialPages.map(rows), 'the same pages with one block in flight')
  t.alike(pages.flatMap(rows), fx.expected)
  t.alike(pages.map((pg) => pg.next), serialPages.map((pg) => pg.next), 'the same cursors')
})

test('hostile candidates: a forged key, a wrong length hint, a repeated key and followed or blocked keys never produce a row', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  const forged = hex(crypto.randomBytes(32))
  const list = [
    { key: forged, length: 7 },
    { key: fx.short, length: 10 },
    ...fx.keys.map((key) => ({ key, length: 4 }))
  ]
  // The first diary again on the second page, and the followed and blocked
  // ones again on the third.
  list.splice(60, 0, { key: fx.keys[0], length: 4 })
  list.splice(100, 0, { key: fx.keys[FOLLOWED[0]], length: 4 }, { key: fx.keys[BLOCKED], length: 4 })
  fx.seeder.discoveryPage = listPages(list)
  t.teardown(() => { delete fx.seeder.discoveryPage })
  const trace = []
  const p = peeker(t, fx, await readerStorage(fx), { limits: { fetchTimeoutMs: 1500 }, events: trace })
  const pages = await allPages(p, 30)
  const all = pages.flatMap(rows)
  t.alike(all, fx.expected, 'exactly the honest rows')
  t.absent(all.some((r) => r.startsWith(forged) || r.startsWith(fx.short)), 'no row of the forged or short diary')
  t.ok(trace.some((e) => e.type === 'get' && e.key === forged && e.seq === 0), 'the forged key was tried from its block 0')
  t.ok(pages.every((pg) => pg.incomplete === true), 'the unavailable candidate leaves every page incomplete')
  t.ok(pages[0].skipped >= 1, 'and is counted as skipped')
})

test('a candidate timeout ends the read incomplete with a usable cursor; the traversal continues with no row twice or missing', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  const gates = []
  const trace = []
  let asked = 0
  const events = {
    push (ev) {
      trace.push(ev)
      // The second candidate page of the snapshot meets a stalled seeder.
      if (ev.type === 'candidates' && ++asked === 2) gates[gates.length - 1].hold = true
    }
  }
  const p = peeker(t, fx, await readerStorage(fx), {
    limits: { candidateTimeoutMs: 800 },
    events,
    createSocket: (u) => {
      const gate = { hold: false }
      gates.push(gate)
      return holdingSocket(u, gate)
    }
  })
  const pages = await allPages(p, 20)
  const cut = pages.findIndex((pg) => pg.incomplete)
  t.ok(cut >= 0, 'the read that met the timeout is incomplete')
  t.ok(pages[cut].next !== null, 'with a usable cursor')
  t.ok(pages[cut].items.length > 0, 'showing what arrived')
  t.alike(pages.flatMap(rows), fx.expected, 'the whole traversal, no row twice or missing')
  t.ok(asked > 2, 'the next read asked a fresh candidate page')
})

test('a stale view mid-traversal restarts from a fresh first candidate page with no row twice or missing', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  let named = 0
  let stale = 0
  fx.seeder.discoveryPage = (q) => {
    if (q.view !== null && ++named === 2) {
      stale++
      return { stale: true }
    }
    return fx.original(q)
  }
  t.teardown(() => { delete fx.seeder.discoveryPage })
  const trace = []
  const p = peeker(t, fx, await readerStorage(fx), { events: trace })
  const pages = await allPages(p, 20)
  t.is(stale, 1, 'one stale answer')
  const cut = pages.findIndex((pg) => pg.incomplete)
  t.ok(cut >= 0, 'the read that met it is incomplete')
  t.ok(pages[cut].next !== null, 'with a usable cursor')
  const fresh = trace.filter((e) => e.type === 'candidates' && e.view === null).length
  t.is(fresh, 2, 'one first page at the start, one fresh first page after the stale answer')
  t.alike(pages.flatMap(rows), fx.expected, 'the whole traversal, no row twice or missing')
})

test('with the first 400 candidates followed, a read stays under the seeder\'s rate and ends incomplete with a usable cursor', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  const ghosts = Array.from({ length: 400 }, () => hex(crypto.randomBytes(32)))
  fx.seeder.discoveryPage = listPages([...ghosts.map((key) => ({ key, length: 5 })), ...fx.keys.map((key) => ({ key, length: 4 }))])
  t.teardown(() => { delete fx.seeder.discoveryPage })
  const before = dropped(fx.events).length
  const trace = []
  const p = peeker(t, fx, await readerStorage(fx, [...FOLLOWED.map((i) => fx.keys[i]), ...ghosts]), { events: trace })
  const started = Date.now()
  const first = await p.read({ limit: 10 })
  const ms = Date.now() - started
  t.is(trace.filter((e) => e.type === 'candidates').length, 8, 'eight candidate pages, the per-read bound')
  t.ok(ms >= 7 * DISCOVERY_PACE_MS - 50, 'paced at one page per ' + DISCOVERY_PACE_MS + ' ms (' + ms + ' ms)')
  t.alike(first.items, [], 'nothing to show yet')
  t.is(first.incomplete, true)
  t.ok(first.next !== null, 'a usable cursor')
  t.is(trace.filter((e) => e.type === 'get').length, 0, 'no followed candidate is fetched')
  const second = await p.read({ limit: 10, after: first.next })
  t.alike(rows(second), fx.expected.slice(0, 9), 'the continuation reaches the real diaries from the start')
  t.is(dropped(fx.events).length, before, 'the seeder never dropped the reader')
})

test('the snapshot stops asking candidates at its cap and pages its rounds to the end', async (t) => {
  t.timeout(240000)
  const fx = await getFixture()
  const trace = []
  // Cap 30 (MAX_INVENTORY by default): the first batch of 48 already passes it.
  const p = peeker(t, fx, await readerStorage(fx), { events: trace, limits: { maxCandidates: 30 } })
  const pages = await allPages(p, 20)
  t.is(pages[pages.length - 1].next, null, 'the list ends')
  t.is(trace.filter((e) => e.type === 'candidates').length, 1, 'no candidate page after the cap')
  const authors = new Set(pages.flatMap((pg) => pg.items.map((it) => it.author)))
  t.ok(authors.size <= 48, 'rows only from the loaded batch (' + authors.size + ' authors)')
  t.ok(pages.every((pg) => pg.incomplete === false), 'a capped snapshot is not incomplete')
})

test('close the fixture', async () => {
  await closeBag()
})
