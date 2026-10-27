// External-socket capacity of the seeder's WebSocket entry with real
// connected members (issue #130), loopback only: a REAL in-process Seeder
// (Hypercore 11) behind startSeedWs (the `seed --ws-port` entry), member
// sync links (connectSeeder, one per Hypercore 10 member in memory, each
// announcing its own diary) and the two short-lived link kinds of the
// browser node: the Espiadinha peek link (lib/peek.js, empty inventory) and
// the Notices link (lib/notices.js, empty inventory + ownership proof).
// Measurement only: no production limit changes, no sub-cap, no link reuse.
//
// Three counts per socket, never conflated:
// - attempted: a WebSocket was created;
// - connected: its HTTP upgrade completed ('open'): seed-ws upgrades BEFORE
//   it asks Seeder#acceptStream, so a refused socket still connects;
// - admitted: the seeder admitted the link (connectSeeder `admitted`; for a
//   peek / notices link, the read got past the verified hello).
// A refusal is the seeder's 'peer-dropped' / 'connection-limit' log line
// (Seeder#acceptStream, checked before the Noise handshake) followed by
// seed-ws's ws.close(1013, 'lotado') (terminate only if the client has not
// answered the close within REFUSE_GRACE_MS = 1 s). The browser links map a
// 1013 close to UsageError(SEEDER_BUSY) 'Semeador ocupado; tente novamente em
// instantes.'; 1006 (no close frame) keeps 'sem conexão com o semeador'.
//
// MEASURED on 2026-10-27 (T9, before the 1013 refusal), Apple M4 Pro (macOS 15 / Darwin 24.6, Node
// v24.22.1), production caps 64/32 (maxConnections MAX_CONNECTIONS = 64,
// maxExternal = floor(64 / 2) = 32; `seed` passes neither):
//   Scenario A, 40 member sync links: attempted 40, connected 40, admitted
//   32, refused 8 (8 'connection-limit' lines, 8 closes with code 1006,
//   now 1013);
//   all 40 opened in 0.46-0.64 s (8 at a time); the 32 admitted links were
//   all still up after the 1.5 s hold. With the 32 slots held, a peek read
//   and a Notices read each fail in 1-3 ms with 'sem conexão com o
//   semeador' (upgrade completed, then 1006; now SEEDER_BUSY / 1013), a
//   bare 33rd socket too: one 'connection-limit' line each. Back to 0
//   sockets after close.
// Test-only caps (maxConnections 64, seeder.maxExternal set to 40 on the
// same seeder; production code untouched):
//   Scenario B: attempted 40, connected 40, admitted 40, refused 0 (opened
//   in 0.14-0.17 s). The 41st short-lived socket is NOT admitted: a peek and
//   a Notices link each get 1006 / 'sem conexão com o semeador' in 1-7 ms
//   (now 1013 / SEEDER_BUSY).
//   With one member link closed (39 held) the peek is the 40th socket and
//   reads a 10-diary page (40 diaries in the inventory, 10 with a post):
//   read 12-20 ms, socket open -> close 11-20 ms, seeder hello -> close
//   8-15 ms; a Notices read (no followers) holds its slot 2-3 ms (hello ->
//   close ~1 ms). Back to 39, then to 0 sockets after close.
//   These lifetimes are LOOPBACK numbers (no network RTT, every diary in
//   the seeder's memory): over a real network each of the peek's request
//   rounds adds an RTT, so a slot is held for proportionally longer.
// Three runs gave the ranges above; the numbers are printed again
// (`# capacity ...` lines) on every run.
//
// MEASURED again on 2026-10-27 (T12, with T10's 1013 refusal and T11's
// SEEDER_BUSY mapping), same machine, three runs:
//   A (64/32, 32 held): 8 overflow member links closed with 1013 (refusals
//   counted by the 'connection-limit' lines as before); the peek and the
//   Notices read fail with USAGE / SEEDER_BUSY in 1-5 ms; a bare 33rd
//   socket: 'connection-limit' line -> client close (1013) in 0-1 ms,
//   i.e. the close handshake, far inside the 1 s grace. Back to 0 sockets.
//   B (64/40, 40 held): 41st peek / Notices fail with SEEDER_BUSY in
//   3-7 ms. With maxExternal raised to 41 (40 still held) the 41st
//   socket is admitted and the peek reads the 10-diary page in 11-14 ms
//   (open -> close 11-13 ms). With maxExternal back to 40 and one member
//   link closed, the peek as the 40th socket reads the page in 10-14 ms.
//   The slot is released after each short-lived read (back to 40 / 39), and
//   to 0 sockets after close.
//
// Not measured here: whether held member links survive the seeder's 30 s
// external idle deadline (EXTERNAL_IDLE_MS) with no traffic; the test keeps
// its runtime well below that, so "stay up" means for the hold window only.
//
// The fixture (seederStack, makeMembers, openMemberLinks, peekOnce,
// noticesOnce, rawSocket, externalCount) is exported so other capacity tests
// can require it; the tests below only register when this file is run.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { MAX_CONNECTIONS } = require('@varanda/core/lib/admission')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { profileRecord, postRecord } = require('@varanda/core/lib/records')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { createPeeker, SEEDER_BUSY } = require('../lib/peek')
const { createNoticer } = require('../lib/notices')
const { memoryNodeStorage } = require('../lib/node-storage')

const NO_SEEDER = 'sem conexão com o semeador'
const MEMBERS = 40
const POSTERS = 10 // the members with a profile and a post: the peek page
const CONCURRENCY = 8 // member links opened at once
const HOLD_MS = 1500 // how long admitted links must stay up

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

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

// The seeder in this process behind startSeedWs, as `seed --ws-port` runs it
// (e2e-social.test.js). `seederOptions` reach the Seeder constructor; none
// means the production defaults. Every log line is kept with its time (ms).
async function seederStack (t, bootstrap, assoc, seederOptions = {}) {
  const dataDir = tmpDir(t, 'varanda-cap-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-cap-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    ...seederOptions,
    log: (e) => {
      events.push({ ms: Date.now(), ...e })
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
    }
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { seeder, events, publicKey, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// Every socket the seeder counts against its connection cap: swarm
// connections plus external ones (in-flight handshakes included).
function externalCount (seeder) {
  return seeder.stats().connections
}

function limitRefusals (events, since = 0) {
  return events.filter((e) => e.ms >= since && e.event === 'peer-dropped' && e.reason === 'connection-limit').length
}

// `count` certified Hypercore 10 members in memory; the first `posters` also
// hold a profile and one post (what a peek page shows).
async function makeMembers (t, assoc, { count, posters = 0 }) {
  const now = Date.now()
  return pool(Array.from({ length: count }, (_, i) => i), CONCURRENCY, async (i) => {
    const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
    t.teardown(() => m.close(), { force: true })
    await m.setCert(createCert({ member: m.key }, assoc.kp))
    if (i < posters) {
      await m.core.append(profileRecord({ name: 'membro ' + i, bio: '' }))
      await m.core.append(postRecord({ text: 'post ' + i, at: new Date(now - (i + 1) * 1000).toISOString() }))
    }
    return m
  })
}

// A WebSocket with its upgrade and close observed: { ws, state } where
// state = { connected, openMs, closeMs, code }.
function rawSocket (t, url) {
  const ws = new WebSocket(url)
  const state = { connected: false, openMs: null, closeMs: null, code: null }
  ws.on('error', () => {})
  ws.once('open', () => { state.connected = true; state.openMs = Date.now() })
  state.closed = new Promise((resolve) => ws.once('close', (code) => {
    state.closeMs = Date.now()
    state.code = code
    resolve(code)
  }))
  t.teardown(() => ws.terminate(), { force: true })
  return { ws, state }
}

// One member sync link per member, CONCURRENCY at a time; each settles on
// admitted or on the link failing (a refused socket fails at once). ->
// [{ member, link, state, admitted, error }].
async function openMemberLinks (t, url, seederKey, assoc, members, { timeoutMs = 30000 } = {}) {
  return pool(members, CONCURRENCY, async (member) => {
    const { ws, state } = rawSocket(t, url)
    const link = connectSeeder({ member, socket: ws, association: assoc.hex, seederPublicKey: seederKey, timeoutMs })
    t.teardown(() => link.close(), { force: true })
    const out = { member, link, state, admitted: false, error: null }
    try {
      await link.admitted
      out.admitted = true
    } catch (err) {
      out.error = err.message
    }
    return out
  })
}

function tally (links) {
  return {
    attempted: links.length,
    connected: links.filter((l) => l.state.connected).length,
    admitted: links.filter((l) => l.admitted).length,
    refused1006: links.filter((l) => !l.admitted && l.state.code === 1006).length,
    refused1013: links.filter((l) => !l.admitted && l.state.code === 1013).length
  }
}

async function closeAll (links) {
  for (const l of links) l.link.close()
  await Promise.all(links.map((l) => l.state.closed))
}

// The sockets of the browser node's short-lived links, observed.
function observedFactory (t, sockets) {
  return (url) => {
    const { ws, state } = rawSocket(t, url)
    sockets.push(state)
    return ws
  }
}

// One Espiadinha read (limit `limit`) over a fresh peeker with empty node
// storage (nothing followed). -> { page, error, ms, socket } with the
// socket's open/close times; `helloMs` is the seeder's `peer` (member) log
// time after the socket opened, i.e. the verified hello on the seeder side.
async function peekOnce (t, stack, assoc, { limit = 10 } = {}) {
  const sockets = []
  const peeker = createPeeker({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: observedFactory(t, sockets)
  })
  t.teardown(() => peeker.close(), { force: true })
  return timedRead(stack, sockets, () => peeker.read({ limit }), () => peeker.close())
}

// One Notices read for `member` (its own key, its signed proof).
async function noticesOnce (t, stack, assoc, member, { limit = 10 } = {}) {
  const sockets = []
  const noticer = createNoticer({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: observedFactory(t, sockets),
    ownKey: async () => member.key,
    sign: (payload) => signNoticeProof(payload, member.keyPair),
    // The noticer requires 32 lowercase hex (lib/notices.js); a test-only
    // digest of the row identity is enough here.
    seenToken: (own, key, seq) => require('node:crypto').createHash('sha256').update(own + ':' + key + ':' + seq).digest('hex').slice(0, 32)
  })
  t.teardown(() => noticer.close(), { force: true })
  return timedRead(stack, sockets, () => noticer.read({ limit }), () => noticer.close())
}

async function timedRead (stack, sockets, read, close) {
  const started = Date.now()
  let page = null
  let error = null
  let errorCode = null
  try {
    page = await read()
  } catch (err) {
    error = err.message
    errorCode = err.code || null
  }
  const ms = Date.now() - started
  close()
  const socket = sockets[0] || null
  if (socket) await socket.closed
  let helloMs = null
  if (socket && socket.openMs !== null) {
    const hello = stack.events.find((e) => e.ms >= socket.openMs && e.event === 'peer' && e.role === 'member')
    if (hello) helloMs = hello.ms
  }
  return {
    page,
    error,
    errorCode,
    ms,
    sockets: sockets.length,
    connected: socket ? socket.connected : false,
    code: socket ? socket.code : null,
    openToCloseMs: socket && socket.openMs !== null ? socket.closeMs - socket.openMs : null,
    helloToCloseMs: helloMs !== null ? socket.closeMs - helloMs : null
  }
}

// Seeder refusal ('connection-limit' line at or after `since`) -> client
// close latency for a socket state; null without a refusal line.
function refusalToCloseMs (events, since, state) {
  const e = events.find((x) => x.ms >= since && x.event === 'peer-dropped' && x.reason === 'connection-limit')
  return e && state.closeMs !== null ? state.closeMs - e.ms : null
}

function report (label, value) {
  console.log('# capacity ' + label + ' ' + JSON.stringify(value))
}

module.exports = {
  seederStack,
  externalCount,
  limitRefusals,
  makeMembers,
  rawSocket,
  openMemberLinks,
  tally,
  closeAll,
  peekOnce,
  noticesOnce,
  refusalToCloseMs
}

if (require.main === module) {
  test('external-socket capacity: production caps 64/32, then test-only maxExternal 40', async (t) => {
    t.timeout(170000)
    const { bootstrap } = await testnet(t)
    const assoc = association()
    const stack = await seederStack(t, bootstrap, assoc)
    const { seeder } = stack
    t.is(seeder.maxConnections, MAX_CONNECTIONS, 'production maxConnections')
    t.is(MAX_CONNECTIONS, 64)
    t.is(seeder.maxExternal, 32, 'production maxExternal = half of 64')
    const baseline = externalCount(seeder)
    t.is(baseline, 0, 'no socket before the test opens any')
    const members = await makeMembers(t, assoc, { count: MEMBERS, posters: POSTERS })

    // ---- Scenario A: production caps ----
    const sinceA = Date.now()
    const startedA = Date.now()
    const linksA = await openMemberLinks(t, stack.url, stack.publicKey, assoc, members)
    const openMsA = Date.now() - startedA
    const a = tally(linksA)
    a.refusedLogged = limitRefusals(stack.events, sinceA)
    a.openAllMs = openMsA
    t.is(a.attempted, MEMBERS, 'A: 40 attempted')
    t.is(a.connected, MEMBERS, 'A: every upgrade completed (seed-ws upgrades before acceptStream)')
    t.is(a.admitted, 32, 'A: the production cap admits 32')
    t.is(a.refused1013, MEMBERS - 32, 'A: the overflow is closed with 1013 (try again later)')
    t.is(a.refused1006, 0, 'A: no overflow socket is terminated without a close frame')
    t.is(a.refusedLogged, MEMBERS - 32, 'A: one connection-limit line per refused socket')
    t.is(externalCount(seeder), 32, 'A: 32 external sockets held')

    // Admitted peers stay up for the hold window.
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    const upA = linksA.filter((l) => l.admitted && !l.link.noise.destroyed).length
    t.is(upA, 32, 'A: the admitted links are still up after the hold window')
    a.upAfterHold = upA

    // A peek-style link and a Notices link while the 32 slots are held.
    const before = limitRefusals(stack.events)
    const peekA = await peekOnce(t, stack, assoc)
    t.is(peekA.error, SEEDER_BUSY, 'A: the peek read says the seeder is busy')
    t.not(peekA.error, NO_SEEDER, 'A: not "sem conexão com o semeador"')
    t.is(peekA.errorCode, 'USAGE', 'A: as a UsageError')
    t.is(peekA.connected, true, 'A: its upgrade completed')
    t.is(peekA.code, 1013, 'A: its socket is closed with 1013')
    const notA = await noticesOnce(t, stack, assoc, members[0])
    t.is(notA.error, SEEDER_BUSY, 'A: the Notices read says the seeder is busy too')
    t.is(notA.errorCode, 'USAGE')
    t.is(notA.code, 1013)
    const rawSince = Date.now()
    const raw = rawSocket(t, stack.url)
    t.is(await raw.state.closed, 1013, 'A: a bare 33rd socket is closed with 1013')
    const rawLatency = refusalToCloseMs(stack.events, rawSince, raw.state)
    t.ok(rawLatency !== null && rawLatency < 1000, 'A: refusal -> close inside the 1 s grace')
    t.is(limitRefusals(stack.events) - before, 3, 'A: three more connection-limit lines')
    a.peek = { error: peekA.error, errorCode: peekA.errorCode, code: peekA.code, failMs: peekA.ms }
    a.notices = { error: notA.error, errorCode: notA.errorCode, code: notA.code, failMs: notA.ms }
    a.raw33 = { code: raw.state.code, refusalToCloseMs: rawLatency }
    report('A (production 64/32)', a)

    await closeAll(linksA)
    await until(() => externalCount(seeder) === baseline, { name: 'A: back to baseline' })
    t.is(externalCount(seeder), baseline, 'A: sockets back to baseline after close')

    // ---- Scenario B: test-only maxExternal 40 on the same seeder ----
    seeder.maxExternal = 40
    const sinceB = Date.now()
    const startedB = Date.now()
    const linksB = await openMemberLinks(t, stack.url, stack.publicKey, assoc, members)
    const b = tally(linksB)
    b.openAllMs = Date.now() - startedB
    b.refusedLogged = limitRefusals(stack.events, sinceB)
    t.is(b.attempted, MEMBERS, 'B: 40 attempted')
    t.is(b.connected, MEMBERS, 'B: 40 connected')
    t.is(b.admitted, MEMBERS, 'B: the test-only cap admits all 40')
    t.is(b.refusedLogged, 0, 'B: nothing refused')
    t.is(externalCount(seeder), MEMBERS, 'B: 40 external sockets held')
    // The posters' diaries are fully served before any peek.
    await Promise.all(linksB.slice(0, POSTERS).map((l) => l.link.waitServed(l.member.core.length)))

    // The 41st short-lived socket (a peek) with the 40 slots held.
    const peekFull = await peekOnce(t, stack, assoc)
    t.is(peekFull.error, SEEDER_BUSY, 'B: the 41st socket (a peek) is refused as busy')
    t.is(peekFull.errorCode, 'USAGE')
    t.is(peekFull.code, 1013)
    const notFull = await noticesOnce(t, stack, assoc, members[0])
    t.is(notFull.error, SEEDER_BUSY, 'B: a Notices link as the 41st is refused as busy too')
    t.is(notFull.code, 1013)
    b.peek41 = { error: peekFull.error, code: peekFull.code, failMs: peekFull.ms }
    b.notices41 = { error: notFull.error, code: notFull.code, failMs: notFull.ms }

    // Test-only cap 41 with the 40 member links held: the 41st short-lived
    // socket is admitted and the peek reads a page.
    seeder.maxExternal = MEMBERS + 1
    const peek41 = await peekOnce(t, stack, assoc)
    t.is(peek41.error, null, 'B: with cap 41 the 41st socket (a peek) reads a page')
    t.is(peek41.page && peek41.page.items.length, POSTERS, 'B: a 10-diary page')
    b.peek41admitted = { items: peek41.page ? peek41.page.items.length : null, readMs: peek41.ms, openToCloseMs: peek41.openToCloseMs, helloToCloseMs: peek41.helloToCloseMs }
    await until(() => externalCount(seeder) === MEMBERS, { name: 'B: 41st slot released' })
    t.is(externalCount(seeder), MEMBERS, 'B: the 41st socket released its slot')
    seeder.maxExternal = MEMBERS

    // One member link closes: 39 held, the peek is the 40th and admitted.
    const last = linksB[linksB.length - 1]
    last.link.close()
    await last.state.closed
    await until(() => externalCount(seeder) === MEMBERS - 1, { name: 'B: 39 held' })
    const peekB = await peekOnce(t, stack, assoc)
    t.is(peekB.error, null, 'B: the peek as the 40th socket reads a page')
    t.is(peekB.page && peekB.page.items.length, POSTERS, 'B: a 10-diary page')
    t.ok(peekB.helloToCloseMs !== null, 'B: hello seen on the seeder')
    b.peek40 = { items: peekB.page ? peekB.page.items.length : null, readMs: peekB.ms, openToCloseMs: peekB.openToCloseMs, helloToCloseMs: peekB.helloToCloseMs }
    const notB = await noticesOnce(t, stack, assoc, members[0])
    t.is(notB.error, null, 'B: a Notices read as the 40th socket completes')
    b.notices40 = { rows: notB.page ? notB.page.notices.length : null, readMs: notB.ms, openToCloseMs: notB.openToCloseMs, helloToCloseMs: notB.helloToCloseMs }
    // The client's close reaches the seeder's slot asynchronously.
    await until(() => externalCount(seeder) === MEMBERS - 1, { name: 'B: short-lived slots released' })
    t.is(externalCount(seeder), MEMBERS - 1, 'B: the short-lived sockets released their slot')
    report('B (test-only 64/40)', b)

    await closeAll(linksB)
    await until(() => externalCount(seeder) === baseline, { name: 'B: back to baseline' })
    t.is(externalCount(seeder), baseline, 'B: sockets back to baseline after close')
  })
}
