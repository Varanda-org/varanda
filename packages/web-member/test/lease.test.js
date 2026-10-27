// The lease of the browser node session (lib/session.js header, docs/rpc.md
// 6.1), against a fake seeder on loopback: a continuous run whose verified
// link is settled for leaseHoldMs ends with sync.stopped reason 'idle' and
// no result, the intent kept; nothing dials again during leaseGapMs except
// sync.start, a diary.peek or a write; a profile.read burst that preempts
// the run every 100 ms does not keep the link up; an own media core blocks
// the lease until the seeder confirms it or leaseMediaMaxMs elapsed; a
// borrow holds it; with leaseHoldMs 0 (the default) the run just runs; a
// sync.stop while an idle run unwinds ends it 'stopped'; a reconnect must
// confirm the media core again; a run ending during a reconnect backoff
// waits for the previous socket's close. The sockets a session opens are
// counted, and two are never open at once.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, WebSocketServer } = require('ws')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { MEDIA_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { connectClient, stoppedOf } = require('./helpers/session')
const { until } = require('./helpers/net')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A seeder stand-in (as sync-gate.test.js): role 'seeder' certified by
// `signer`, replicating `spy` cores without advertising them (the seeder
// side of an own media core); it admits an announced diary at the length
// the member advertised, so the link settles as soon as the hello is in.
// spy may be a function (connection index) -> cores; `connections` keeps
// the server side sockets, in order.
async function fakeSeeder (t, { signer, spy = [] }) {
  const connections = []
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const cores = typeof spy === 'function' ? spy(connections.length) : spy
    connections.push(ws)
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of cores) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [],
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', connections }
}

// A server that accepts the WebSocket and never answers the Noise
// handshake: the member's link times out unverified.
async function silentSeeder (t) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => { ws.on('error', () => {}) })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// A peer that is slow to finish the close handshake: close() reports
// CLOSING at once and reaches the real socket only after `delayMs`.
function slowClose (ws, delayMs, onClose) {
  let closing = false
  return {
    get readyState () {
      const state = ws.readyState
      return closing && state < WebSocket.CLOSING ? WebSocket.CLOSING : state
    },
    get binaryType () { return ws.binaryType },
    set binaryType (value) { ws.binaryType = value },
    addEventListener: (name, fn) => ws.addEventListener(name, fn),
    removeEventListener: (name, fn) => ws.removeEventListener(name, fn),
    send: (data) => ws.send(data),
    close (code) {
      if (closing) return
      closing = true
      onClose()
      setTimeout(() => {
        try { ws.close(code) } catch {}
      }, delayMs)
    }
  }
}

// createSocket for a node: every socket is kept, and opening one while a
// previous one is not CLOSED yet is recorded as an overlap. closeDelayMs:
// every socket closes slowly (slowClose); closeCalls counts close() calls.
function socketTap ({ closeDelayMs = 0 } = {}) {
  const sockets = []
  const tap = {
    sockets,
    overlaps: 0,
    closeCalls: 0,
    createSocket (url) {
      if (sockets.some((s) => s.readyState !== WebSocket.CLOSED)) tap.overlaps++
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      const socket = closeDelayMs > 0 ? slowClose(ws, closeDelayMs, () => { tap.closeCalls++ }) : ws
      sockets.push(socket)
      return socket
    }
  }
  return tap
}

const SYNC_OPTIONS = { retryMinMs: 100, retryMaxMs: 300, mediaPollMs: 50 }

// A certified member on a node wired to `seederUrl`, the write gate off
// (no seeder run around a write: the lease alone is under test).
async function member (t, { seederUrl, assoc = association(), mediaKeyPair = null, closeDelayMs = 0, ...options }) {
  const tap = socketTap({ closeDelayMs })
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl,
    createSocket: tap.createSocket,
    onInternalError: (err) => internal.push(err),
    syncOptions: SYNC_OPTIONS,
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), mediaKeyPair === null ? {} : { media: mediaKeyPair })
  const web = await connectClient(node)
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, assoc, tap, internal, key: publicKey }
}

function stoppedEvents (web, runId) {
  return web.events.filter((e) => e.name === 'sync.stopped' && e.data.runId === runId)
}

function startedCount (web) {
  return web.events.filter((e) => e.name === 'sync.started').length
}

test('an idle leased run emits reason idle, keeps the intent, and only sync.start, a peek or a write dial again', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const { web, tap, internal, key } = await member(t, { seederUrl: seeder.url, assoc, leaseHoldMs: 300, leaseGapMs: 2500 })

  const startedAt = Date.now()
  const { runId } = await web.request('sync.start', {})
  const stopped = await stoppedOf(web.events, runId)
  t.is(stopped.reason, 'idle', 'the settled run ended idle')
  t.absent('result' in stopped, 'no result (a continuous run)')
  t.ok(Date.now() - startedAt >= 300, 'not before the hold')
  t.alike(await web.request('sync.status', {}), { state: 'idle' })
  t.absent(web.events.some((e) => e.name === 'sync.event' && /settled/.test(e.data.line)), 'the readiness report makes no line')

  // Member reads inside the gap: no socket, no run.
  const sockets = tap.sockets.length
  const started = startedCount(web)
  await web.request('profile.read', { authors: [key] })
  await web.request('feed.read', {})
  await web.request('log.read', {})
  await web.request('engagement.read', { refs: [key + ':1'] })
  await web.request('follow.list', {})
  const info = await web.request('node.info', {})
  t.alike(info.sync, { state: 'idle' }, 'node.info reports no run')
  t.alike(await web.request('sync.status', {}), { state: 'idle' })
  t.is(tap.sockets.length, sockets, 'no socket opened by the reads of the gap')
  t.is(startedCount(web), started, 'no run started by them')

  // sync.start inside the gap starts at once.
  const { runId: second } = await web.request('sync.start', {})
  t.ok(await until(() => tap.sockets.length === sockets + 1), 'sync.start dialled (the run dials after opening the diary)')
  t.is((await stoppedOf(web.events, second)).reason, 'idle', 'and that run went idle again')

  // A write inside the gap: the continuous run restarts after it.
  const before = tap.sockets.length
  await web.request('post.create', { text: 'na varanda' })
  const after = await web.request('sync.status', {})
  t.is(after.state, 'running', 'the write restarted the run')
  t.is(after.once, false)
  t.ok(await until(() => tap.sockets.length === before + 1), 'one socket for it')
  t.is((await stoppedOf(web.events, after.runId)).reason, 'idle', 'settled again (the seeder holds the new length)')

  // A diary.peek inside the gap: served by a run it restarts.
  const beforePeek = tap.sockets.length
  const peeked = await web.request('diary.peek', { author: key, seqs: [1] })
  t.is(peeked.entries.length, 1, 'the own post, read through the restarted run')
  t.is(peeked.entries[0].record.text, 'na varanda')
  t.is(tap.sockets.length, beforePeek + 1, 'one socket for it')
  const running = await web.request('sync.status', {})
  t.is(running.state, 'running')
  t.is((await stoppedOf(web.events, running.runId)).reason, 'idle')

  // sync.stop inside the gap: nothing to stop, and nothing restarts.
  t.alike(await web.request('sync.stop', {}), { stopped: false })
  await web.request('feed.read', {})
  t.alike(await web.request('sync.status', {}), { state: 'idle' })

  t.is(tap.overlaps, 0, 'two sockets were never open at once')
  t.alike(internal, [])
})

test('a profile.read every 100 ms does not keep the link up: the lease goes idle after the hold and the gap stays quiet', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const { web, tap, internal, key } = await member(t, { seederUrl: seeder.url, assoc, leaseHoldMs: 800, leaseGapMs: 3000 })

  const startedAt = Date.now()
  await web.request('sync.start', {})
  // Reads until some run ends idle (each one preempts and restarts the run).
  let idle = null
  while (idle === null && Date.now() - startedAt < 20000) {
    await web.request('profile.read', { authors: [key] })
    await sleep(100)
    idle = web.events.find((e) => e.name === 'sync.stopped' && e.data.reason === 'idle') || null
  }
  t.ok(idle !== null, 'the lease went idle under the burst')
  t.ok(Date.now() - startedAt >= 800, 'not before the hold')
  t.ok(web.events.filter((e) => e.name === 'sync.stopped' && e.data.reason === 'preempted').length > 0, 'the reads did preempt runs meanwhile')

  // The reads go on inside the gap: no socket, no run.
  const sockets = tap.sockets.length
  const started = startedCount(web)
  for (let i = 0; i < 6; i++) {
    await web.request('profile.read', { authors: [key] })
    await web.request('feed.read', {})
    await sleep(100)
  }
  t.is(tap.sockets.length, sockets, 'no socket opened in the gap')
  t.is(startedCount(web), started, 'no run started in the gap')
  t.alike(await web.request('sync.status', {}), { state: 'idle' })
  t.is(tap.overlaps, 0, 'two sockets were never open at once')
  t.alike(internal, [])
})

test('a sync.stop queued behind a preempting read clears the hold clocks: a later start earns its own hold', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const { web, key } = await member(t, { seederUrl: seeder.url, assoc, leaseHoldMs: 700, leaseGapMs: 3000 })

  await web.request('sync.start', {})
  await sleep(450) // settled, the hold clock running
  // The read preempts the run (a preempted end keeps the clocks); the stop
  // queued behind it then finds no run.
  await Promise.all([web.request('profile.read', { authors: [key] }), web.request('sync.stop', {})])
  await sleep(400) // past the old hold deadline
  const before = web.events.length
  await web.request('sync.start', {})
  await sleep(350) // settled again, still well inside a fresh hold
  const idleSoon = web.events.slice(before).find((e) => e.name === 'sync.stopped' && e.data.reason === 'idle')
  t.absent(idleSoon, 'the new run is not cut by the stale hold')
  await web.request('sync.stop', {})
})

test('an unconfirmed own media core blocks the lease until leaseMediaMaxMs; a confirmed one does not', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const bytes = new Uint8Array(MEDIA_BLOCK_BYTES * 2 + 100)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 5) & 0xff

  // The seeder never replicates the media core: pending until the media wait.
  const quiet = await fakeSeeder(t, { signer: assoc.kp })
  const m1 = await member(t, { seederUrl: quiet.url, assoc, mediaKeyPair: crypto.keyPair(), leaseHoldMs: 200, leaseGapMs: 1000, leaseMediaMaxMs: 1500 })
  const d1 = await m1.node.mediaUpload({ bytes, mime: 'image/jpeg', width: 640, height: 480 })
  t.is(d1.blocks, 3)
  const t1 = Date.now()
  const { runId: r1 } = await m1.web.request('sync.start', {})
  await sleep(900)
  t.alike(stoppedEvents(m1.web, r1), [], 'still running after the hold: the media core is not confirmed')
  const s1 = await stoppedOf(m1.web.events, r1)
  t.is(s1.reason, 'idle', 'idle once leaseMediaMaxMs elapsed')
  t.ok(Date.now() - t1 >= 1500, 'not before it')
  t.is(m1.tap.overlaps, 0)

  // The seeder side downloads the media core: confirmed, the hold alone counts.
  const mediaKeyPair = crypto.keyPair()
  const spy = new Hypercore(memoryStorage(), mediaKeyPair.publicKey)
  await spy.ready()
  t.teardown(() => spy.close(), { force: true })
  spy.download({ start: 0, end: -1 })
  const holding = await fakeSeeder(t, { signer: assoc.kp, spy: [spy] })
  const m2 = await member(t, { seederUrl: holding.url, assoc, mediaKeyPair, leaseHoldMs: 200, leaseGapMs: 1000, leaseMediaMaxMs: 20000 })
  const d2 = await m2.node.mediaUpload({ bytes, mime: 'image/jpeg', width: 640, height: 480 })
  t.is(d2.core, hex(mediaKeyPair.publicKey))
  const t2 = Date.now()
  const { runId: r2 } = await m2.web.request('sync.start', {})
  const s2 = await stoppedOf(m2.web.events, r2)
  t.is(s2.reason, 'idle')
  t.ok(Date.now() - t2 < 10000, 'well before leaseMediaMaxMs')
  t.is(spy.contiguousLength, d2.start + d2.blocks, 'the seeder side holds every block')
  t.is(m2.tap.overlaps, 0)
  t.alike(m1.internal, [])
  t.alike(m2.internal, [])
})

test('with leaseHoldMs 0 (the default) a settled continuous run keeps running', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const { web, tap, internal } = await member(t, { seederUrl: seeder.url, assoc })
  const { runId } = await web.request('sync.start', {})
  t.ok(await until(() => web.events.some((e) => e.name === 'sync.event' && e.data.runId === runId && /^admitted /.test(e.data.line))), 'admitted by the seeder')
  await sleep(1200)
  t.alike(stoppedEvents(web, runId), [], 'no stop')
  t.alike(await web.request('sync.status', {}), { state: 'running', runId, once: false })
  t.is(tap.sockets.length, 1, 'one socket')
  t.alike(await web.request('sync.stop', {}), { stopped: true })
  t.is((await stoppedOf(web.events, runId)).reason, 'stopped')
  t.alike(internal, [])
})

test('borrow(fn) holds the lease while fn runs', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const tap = socketTap()
  const events = []
  const session = createBrowserSession({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: seeder.url,
    createSocket: tap.createSocket,
    syncOptions: SYNC_OPTIONS,
    writeGate: false,
    leaseHoldMs: 200,
    leaseGapMs: 1000
  })
  t.teardown(() => session.close(), { force: true })
  session.attach((event, data) => events.push({ event, data }))
  await session.setKeyPair(crypto.keyPair())
  const { publicKey } = await session.handlers['identity.create']({})
  await session.handlers['cert.add']({ cert: createCert({ member: publicKey }, assoc.kp) })

  const startedAt = Date.now()
  const { runId } = await session.handlers['sync.start']({ once: false })
  const stoppedFor = (id) => events.find((e) => e.event === 'sync.stopped' && e.data.runId === id)
  // Two borrowers: the hold waits for the last of them.
  let released = 0
  const a = session.borrow(async () => { await sleep(700); released++ })
  const b = session.borrow(async () => { await sleep(1000); released++; return 'ok' })
  await sleep(600)
  t.absent(stoppedFor(runId), 'still running after the hold: borrowed')
  await a
  await sleep(200)
  t.absent(stoppedFor(runId), 'still borrowed by the second')
  t.is(await b, 'ok', 'borrow returns what fn returns')
  t.is(released, 2)
  t.ok(await until(() => stoppedFor(runId) !== undefined, 5000), 'idle once the last borrow returned')
  t.alike(stoppedFor(runId).data, { runId, reason: 'idle' })
  t.ok(Date.now() - startedAt >= 1000)
  // A borrow whose fn throws releases the count too.
  await t.exception(session.borrow(async () => { throw new Error('x') }), /x/)
  t.is(tap.overlaps, 0)
})

test('a diary.peek issued around the hold is served, never timed out: it holds the lease, and one waiting when the run ends is redialled', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const { web, tap, internal, key } = await member(t, { seederUrl: seeder.url, assoc, leaseHoldMs: 200, leaseGapMs: 3000, peekTimeoutMs: 3000 })
  await web.request('post.create', { text: 'na varanda' })
  await web.request('sync.start', {})
  const idle = () => web.events.filter((e) => e.name === 'sync.stopped' && e.data.reason === 'idle').length
  // Peeks spaced by less than the hold, until the lease ended the run twice
  // under them: a peek in flight when the hold would fire holds it; one
  // issued while the idle run unwinds waits for the restarted run.
  const started = Date.now()
  const failures = []
  let served = 0
  while (idle() < 2 && Date.now() - started < 30000) {
    try {
      const r = await web.request('diary.peek', { author: key, seqs: [1] })
      if (r.entries.length === 1 && r.entries[0].record.text === 'na varanda') served++
      else failures.push('entries ' + JSON.stringify(r.entries))
    } catch (err) {
      failures.push(err.message)
    }
    await sleep(60)
  }
  t.ok(idle() >= 2, 'the lease ended the run under the peeks: ' + idle())
  t.alike(failures, [], 'every peek was served')
  t.ok(served >= 4, 'peeks served: ' + served)
  t.is(tap.overlaps, 0, 'two sockets were never open at once')
  t.alike(internal, [])
})

test('a sync.stop that lands while an idle run unwinds ends it stopped, and nothing redials', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  // The socket's close takes 700 ms: the idle run unwinds that long.
  const { web, tap, internal, key } = await member(t, { seederUrl: seeder.url, assoc, leaseHoldMs: 300, leaseGapMs: 500, closeDelayMs: 700 })

  const { runId } = await web.request('sync.start', {})
  // The hold fired: the run destroyed its link and waits for the socket.
  t.ok(await until(() => tap.closeCalls === 1, 10000), 'the lease ended the link')
  t.alike(stoppedEvents(web, runId), [], 'the run is still unwinding')
  t.alike(await web.request('sync.stop', {}), { stopped: true })
  const stopped = await stoppedOf(web.events, runId)
  t.is(stopped.reason, 'stopped', 'the explicit stop wins over idle (the intent was cleared)')

  // Past the (short) gap, member reads do not redial: no intent.
  const sockets = tap.sockets.length
  const started = startedCount(web)
  await sleep(800)
  await web.request('profile.read', { authors: [key] })
  await web.request('feed.read', {})
  await web.request('sync.status', {})
  await sleep(200)
  t.is(tap.sockets.length, sockets, 'no socket opened')
  t.is(startedCount(web), started, 'no run started')
  t.alike(await web.request('sync.status', {}), { state: 'idle' })
  t.is(tap.overlaps, 0)
  t.alike(internal, [])
})

test('after a link drop the reconnected link must confirm the media core again before the lease goes idle', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const bytes = new Uint8Array(MEDIA_BLOCK_BYTES * 2 + 100)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff
  const mediaKeyPair = crypto.keyPair()
  // The first connection downloads (and so confirms) the media core; the
  // second one never replicates it: a seeder that is behind.
  const spy = new Hypercore(memoryStorage(), mediaKeyPair.publicKey)
  await spy.ready()
  t.teardown(() => spy.close(), { force: true })
  spy.download({ start: 0, end: -1 })
  const seeder = await fakeSeeder(t, { signer: assoc.kp, spy: (n) => n === 0 ? [spy] : [] })
  const MEDIA_MAX = 2500
  const { node, web, tap, internal } = await member(t, { seederUrl: seeder.url, assoc, mediaKeyPair, leaseHoldMs: 1500, leaseGapMs: 5000, leaseMediaMaxMs: MEDIA_MAX })
  const d = await node.mediaUpload({ bytes, mime: 'image/jpeg', width: 640, height: 480 })

  const { runId } = await web.request('sync.start', {})
  t.ok(await until(() => spy.contiguousLength === d.start + d.blocks, 10000), 'the first link carried every block')
  // Dropped before the hold: the member reconnects to a seeder that is behind.
  seeder.connections[0].terminate()
  t.ok(await until(() => tap.sockets.length === 2, 10000), 'reconnected')
  const reconnectedAt = Date.now()
  await sleep(2000)
  t.alike(stoppedEvents(web, runId), [], 'past the hold after the reconnect, still running: the media core is pending again')
  const stopped = await stoppedOf(web.events, runId)
  t.is(stopped.reason, 'idle', 'idle once leaseMediaMaxMs elapsed on the new link')
  t.ok(Date.now() - reconnectedAt >= MEDIA_MAX, 'not before it')
  t.is(seeder.connections.length, 2)
  t.is(tap.overlaps, 0)
  t.alike(internal, [])
})

test('a preemption during a reconnect backoff waits for the previous socket still closing', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await silentSeeder(t)
  // The link times out unverified after 300 ms; its socket then takes
  // 700 ms to close, and the reconnect waits at least 3 s.
  const { web, tap, internal, key } = await member(t, {
    seederUrl: seeder.url,
    assoc,
    closeDelayMs: 700,
    syncOptions: { ...SYNC_OPTIONS, connectTimeoutMs: 300, retryMinMs: 3000, retryMaxMs: 3000 }
  })

  const { runId } = await web.request('sync.start', {})
  t.ok(await until(() => tap.closeCalls === 1, 10000), 'the unverified link timed out')
  t.is(tap.sockets[0].readyState, WebSocket.CLOSING, 'its socket is still closing')
  // Preempted inside the backoff: the restarted run must not dial before
  // the old socket closed.
  await web.request('profile.read', { authors: [key] })
  t.is((await stoppedOf(web.events, runId)).reason, 'preempted')
  t.ok(await until(() => tap.sockets.length === 2, 10000), 'the restarted run dialled')
  t.is(tap.overlaps, 0, 'two sockets were never open at once')
  await web.request('sync.stop', {})
  t.alike(internal, [])
})
