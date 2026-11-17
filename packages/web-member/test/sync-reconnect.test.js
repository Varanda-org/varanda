'use strict'

// Re-dial after the seeder drops. retryWait is the pure backoff: inside the
// fast window the cap is 5 s and each wait is shortened by up to a quarter,
// so a redeploy is redialled quickly and clients retry at different times.
// retryFastWindowMs 0 is the doubling ladder. A closed TCP port must be
// dialled at least 12 times within 10 s (the old 1, 2, 4 ... 30 s ladder
// reaches its 12th dial only after about 20 s when the minimum is 10 ms).
// A 1012 close (the seeder is stopping for a deploy) is a restart:
// 'seeder-restarting' before 'link-closed', then a short jittered redial
// that does not count as a failed attempt. The peer's close reason is
// never logged or emitted.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, WebSocketServer } = require('ws')
const { testnet, until } = require('./helpers/net')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { wsStream } = require('../lib/ws-stream')
const { runSync, retryWait, restartWait, RETRY_FAST_MAX_MS, RETRY_FAST_WINDOW_MS, RETRY_JITTER, RESTART_WAIT_MS, RESTART_JITTER_MS } = require('../lib/sync')
const ops = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')

const FAST_MAX_MS = 5000
const FAST_WINDOW_MS = 180000
const RETRY_WARNING = /^aviso: sem conexão com o semeador; nova tentativa em (\d+) s$/
const BUSY_WARNING = 'aviso: semeador ocupado; tente novamente em instantes'
const RESTART_WARNING = 'aviso: semeador reiniciando; reconectando em instantes'

function retry (over = {}) {
  return retryWait({
    failures: 0,
    downMs: 0,
    minMs: 1000,
    maxMs: 30000,
    fastMaxMs: FAST_MAX_MS,
    fastWindowMs: FAST_WINDOW_MS,
    jitter: 0,
    random: () => 0,
    ...over
  })
}

function ladder (failures, minMs, maxMs, extra = {}) {
  const seq = []
  for (let n = 0; n < failures; n++) seq.push(retry({ failures: n, minMs, maxMs, ...extra }))
  return seq
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// A loopback port with nothing listening (bound, then released).
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function memberStorage (assocKp = generateAssociationKeyPair()) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair: crypto.keyPair() }
  const { publicKey } = await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: publicKey }, assocKp))
  return storage
}

// A seeder stand-in (as lease.test.js): it verifies and admits the member's
// diary (onAnnounce runs once it is announced, so after the member verified
// the seeder), so the link settles. connections keeps the server side sockets.
async function fakeSeeder (t, signer, onAnnounce = () => {}) {
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
    connections.push(ws)
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [],
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
          onAnnounce()
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', connections }
}

function retrySeconds (lines) {
  const out = []
  for (const line of lines) {
    const m = RETRY_WARNING.exec(line)
    if (m) out.push(Number(m[1]))
  }
  return out
}

function eventIndex (handle, name) {
  return handle.events.findIndex((ev) => ev && ev.event === name)
}

// The peer's close reason must not show up in a log line or an event.
function leaked (handle, text) {
  for (const line of handle.lines) {
    if (String(line).includes(text)) return true
  }
  for (const ev of handle.events) {
    if (JSON.stringify(ev).includes(text)) return true
  }
  return false
}

async function closeServer (t, onConnection) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate()
    wss.close(() => resolve())
  }), { force: true })
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    onConnection(ws)
  })
  return 'ws://127.0.0.1:' + wss.address().port + '/seeder'
}

// Starts a continuous run and records every dial and log line. The returned
// done promise settles with a rejection stored on the handle, so a startup
// failure surfaces from until() instead of as an unhandled rejection.
function drive (t, seederUrl, storage, opts = {}) {
  const times = []
  const lines = []
  const events = []
  const handle = { times, lines, events, failure: null, ac: new AbortController(), done: null }
  t.teardown(() => handle.ac.abort(), { force: true })
  handle.done = runSync({
    storage,
    seederUrl,
    signal: handle.ac.signal,
    startupSlowMs: 120000,
    ...opts,
    log: (line) => lines.push(line),
    onEvent: (ev) => events.push(ev),
    createSocket: (url) => {
      times.push(Date.now())
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    }
  }).catch((err) => { handle.failure = err })
  return handle
}

async function stop (handle) {
  handle.ac.abort()
  await handle.done
}

test('retryWait caps at 5000 inside the fast window', (t) => {
  t.alike(ladder(5, 1000, 30000), [1000, 2000, 4000, 5000, 5000])
  t.is(retry({ failures: 20, downMs: FAST_WINDOW_MS - 1 }), FAST_MAX_MS)
})

test('retryWait uses maxMs outside the fast window', (t) => {
  t.is(retry({ failures: 20, downMs: FAST_WINDOW_MS }), 30000)
  t.is(retry({ failures: 20, downMs: FAST_WINDOW_MS + 60000 }), 30000)
})

test('retryWait jitter: random 0 keeps the base, random 1 keeps 0.75 of the base', (t) => {
  t.is(retry({ failures: 2, jitter: 0.25, random: () => 0 }), 4000)
  t.is(retry({ failures: 2, jitter: 0.25, random: () => 1 }), 3000)
  t.is(retry({ failures: 10, jitter: 0.25, random: () => 0 }), 5000)
  t.is(retry({ failures: 10, jitter: 0.25, random: () => 1 }), 3750)
  const picked = retryWait({
    failures: 0,
    downMs: 0,
    minMs: 1000,
    maxMs: 30000,
    fastMaxMs: FAST_MAX_MS,
    fastWindowMs: FAST_WINDOW_MS,
    jitter: 0.25
  })
  t.ok(picked >= 750 && picked <= 1000, 'default random shortens by at most the jitter, got ' + picked)
})

test('a large failures value does not overflow', (t) => {
  const capped = 1000 * (2 ** 16)
  const over = {
    failures: Number.MAX_SAFE_INTEGER,
    downMs: FAST_WINDOW_MS,
    minMs: 1000,
    maxMs: 1e9,
    fastMaxMs: FAST_MAX_MS,
    fastWindowMs: FAST_WINDOW_MS
  }
  t.is(retry(over), capped)
  t.is(retry({ ...over, jitter: 0.25, random: () => 1 }), Math.round(capped * 0.75))
  t.is(retry({ ...over, failures: 16 }), capped)
})

test('retryFastWindowMs 0 keeps the doubling ladder with jitter 0', (t) => {
  // downMs 0 would be inside the fast window; a zero window forces maxMs.
  t.alike(
    ladder(8, 1000, 30000, { downMs: 0, fastWindowMs: 0, jitter: 0, random: () => 1 }),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
  )
})

test('retryWait clamps jitter to [0, 1] and treats NaN as 0', (t) => {
  t.is(retry({ failures: 1, jitter: NaN, random: () => 1 }), 2000)
  t.is(retry({ failures: 1, jitter: -1, random: () => 1 }), 2000)
  t.is(retry({ failures: 1, jitter: 5, random: () => 1 }), 0)
})

test('the exported retry defaults', (t) => {
  t.is(RETRY_FAST_MAX_MS, 5000)
  t.is(RETRY_FAST_WINDOW_MS, 180000)
  t.is(RETRY_JITTER, 0.25)
  t.is(RESTART_WAIT_MS, 500)
  t.is(RESTART_JITTER_MS, 1000)
})

test('restartWait is the base plus up to the jitter', (t) => {
  t.is(restartWait({ waitMs: 500, jitterMs: 1000, random: () => 0 }), 500)
  t.is(restartWait({ waitMs: 500, jitterMs: 1000, random: () => 1 }), 1500)
  t.is(restartWait({ waitMs: NaN, jitterMs: 1000, random: () => 1 }), 1000)
  t.is(restartWait({ waitMs: 500, jitterMs: NaN, random: () => 1 }), 500)
  t.is(restartWait({ waitMs: -5, jitterMs: -5, random: () => 1 }), 0)
  t.is(restartWait({ waitMs: '500', jitterMs: 1000, random: () => 1 }), 1000)
  const picked = restartWait({ waitMs: RESTART_WAIT_MS, jitterMs: RESTART_JITTER_MS })
  t.ok(picked >= 500 && picked <= 1500, 'default random stays in 500 to 1500, got ' + picked)
})

test('a maxMs below the fast cap stays the cap', (t) => {
  t.alike(ladder(5, 100, 200, { fastMaxMs: FAST_MAX_MS }), [100, 200, 200, 200, 200])
  t.is(retry({ failures: 10, minMs: 100, maxMs: 200, fastMaxMs: FAST_MAX_MS, jitter: 0.25, random: () => 1 }), 150)
})

test('a closed port is dialled at least 12 times within 10 s', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const port = await deadPort()
  const run = drive(t, 'ws://127.0.0.1:' + port + '/seeder', await memberStorage(), {
    retryMinMs: 10,
    retryFastMaxMs: 40
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return run.times.length >= 12
    }, { timeoutMs: 30000, name: '12 dials' })
    const span = run.times[11] - run.times[0]
    t.ok(run.times.length >= 12, 'dials ' + run.times.length)
    t.ok(span < 10000, '12 dials in ' + span + ' ms')
    t.ok(retrySeconds(run.lines).length >= 1, 'retry warning kept')
  } finally {
    await stop(run)
  }
})

test('retryFastWindowMs 0 on a run logs the doubling ladder', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const port = await deadPort()
  // ceil(ms/1000) of 1000, 2000, 4000, 4000. The fast cap of 2 s is not in
  // force (window 0), and the fourth step shows retryMaxMs.
  const run = drive(t, 'ws://127.0.0.1:' + port + '/seeder', await memberStorage(), {
    retryMinMs: 1000,
    retryMaxMs: 4000,
    retryFastMaxMs: 2000,
    retryFastWindowMs: 0,
    retryJitter: 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return retrySeconds(run.lines).length >= 4
    }, { timeoutMs: 40000, name: 'ladder' })
    t.alike(retrySeconds(run.lines).slice(0, 4), [1, 2, 4, 4])
  } finally {
    await stop(run)
  }
})

test('a 1013 close keeps the full retry cap', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate()
    wss.close(() => resolve())
  }), { force: true })
  wss.on('connection', (ws) => ws.close(1013, 'lotado'))
  const url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  // Doubling 100, 200, 400, 800, 1600, 3200. The fast cap of 100 would land
  // the 7th dial well under 5 s even with slow handshakes.
  const run = drive(t, url, await memberStorage(), {
    retryMinMs: 100,
    retryMaxMs: 3200,
    retryFastMaxMs: 100,
    retryJitter: 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return run.times.length >= 7
    }, { timeoutMs: 30000, name: '7 dials' })
    const span = run.times[6] - run.times[0]
    t.ok(span > 5000, 'full cap span ' + span + ' ms')
    t.ok(span < 20000, 'full cap span ' + span + ' ms')
    t.ok(run.lines.includes(BUSY_WARNING), '1013 warning kept')
    t.ok(!run.lines.includes(RESTART_WARNING), '1013 is not a restart')
    t.ok(retrySeconds(run.lines).length >= 1, 'retry warning kept')
    const busyAt = eventIndex(run, 'seeder-busy')
    const closedAt = eventIndex(run, 'link-closed')
    t.ok(busyAt !== -1 && closedAt === busyAt + 1, 'seeder-busy before link-closed')
    t.alike(run.events[busyAt], { event: 'seeder-busy' })
    t.is(eventIndex(run, 'seeder-restarting'), -1, '1013 is not seeder-restarting')
    t.ok(!leaked(run, 'lotado'), '1013 reason not logged or emitted')
  } finally {
    await stop(run)
  }
})

test('a 1012 close warns, emits seeder-restarting, and redials inside the restart window', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const REASON = 'zz-peer-reason-zz'
  const url = await closeServer(t, (ws) => ws.close(1012, REASON))
  // random 0 keeps the wait at restartWaitMs. The ordinary ladder would
  // wait retryMinMs (3 s) and would not emit seeder-restarting.
  const run = drive(t, url, await memberStorage(), {
    retryMinMs: 3000,
    retryFastMaxMs: 3000,
    retryJitter: 0,
    restartWaitMs: 70,
    restartJitterMs: 4000,
    random: () => 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return run.times.length >= 2 && retrySeconds(run.lines).length >= 1
    }, { timeoutMs: 15000, name: 'restart redial' })
    const gap = run.times[1] - run.times[0]
    t.ok(run.lines.includes(RESTART_WARNING), '1012 warning kept')
    t.is(retrySeconds(run.lines)[0], 1, 'restart wait logs 1 s, not the 3 s ladder')
    const restartAt = eventIndex(run, 'seeder-restarting')
    const closedAt = eventIndex(run, 'link-closed')
    t.ok(restartAt !== -1 && closedAt === restartAt + 1, 'seeder-restarting before link-closed')
    t.alike(run.events[restartAt], { event: 'seeder-restarting' })
    t.is(eventIndex(run, 'seeder-busy'), -1, '1012 is not seeder-busy')
    t.ok(!leaked(run, REASON), 'peer reason not logged or emitted')
    // The log line above is what tells the restart wait from the ladder;
    // the upper bound is only a guard against a stalled run.
    t.ok(gap >= 70 && gap < 5000, 'restart window gap ' + gap + ' ms')
  } finally {
    await stop(run)
  }
})

test('after a 1012 close a failed redial keeps the current failures', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const REASON = 'zz-peer-reason-zz'
  let n = 0
  const url = await closeServer(t, (ws) => {
    n++
    // Later closes have no close frame: the client records 1006.
    if (n === 1) {
      ws.close(1012, REASON)
    } else {
      ws.terminate()
    }
  })
  // 1012 does not bump failures. The next two waits are retryWait at
  // failures 0 then 1 (1200 ms, 2400 ms), still inside the fast window.
  // A bump would log 3 s then 5 s.
  const ladderOpts = {
    minMs: 1200,
    maxMs: 20000,
    fastMaxMs: 5000,
    fastWindowMs: FAST_WINDOW_MS,
    jitter: 0,
    random: () => 0
  }
  const at = (failures) => retryWait({ failures, downMs: 0, ...ladderOpts })
  const run = drive(t, url, await memberStorage(), {
    retryMinMs: ladderOpts.minMs,
    retryMaxMs: ladderOpts.maxMs,
    retryFastMaxMs: ladderOpts.fastMaxMs,
    retryFastWindowMs: ladderOpts.fastWindowMs,
    retryJitter: 0,
    restartWaitMs: 50,
    restartJitterMs: 0,
    random: () => 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return run.times.length >= 3 && retrySeconds(run.lines).length >= 3
    }, { timeoutMs: 20000, name: 'waits after the restart' })
    t.is(at(0), 1200)
    t.is(at(1), 2400)
    t.is(at(2), 4800)
    t.alike(retrySeconds(run.lines).slice(0, 3), [
      1,
      Math.ceil(at(0) / 1000),
      Math.ceil(at(1) / 1000)
    ])
    const restartGap = run.times[1] - run.times[0]
    const followGap = run.times[2] - run.times[1]
    t.ok(restartGap < 5000, 'restart redial in ' + restartGap + ' ms')
    t.ok(followGap >= at(0) - 100, 'unbumped retry gap ' + followGap + ' ms')
    t.ok(!leaked(run, REASON), 'peer reason not logged or emitted')
    t.ok(run.lines.includes(RESTART_WARNING), '1012 warning kept')
  } finally {
    await stop(run)
  }
})

test('only the first 1012 of a down streak skips the backoff', async (t) => {
  t.timeout(60000)
  await testnet(t)
  // The close code arrives outside Noise, so a server (or anything on the
  // path) that always answers 1012 must not keep the client on the quick
  // redial: the first wait is the restart wait, then retryWait from
  // failures 0, 1, as for any failure.
  const url = await closeServer(t, (ws) => ws.close(1012, 'reiniciando'))
  const ladderOpts = {
    minMs: 1200,
    maxMs: 20000,
    fastMaxMs: 5000,
    fastWindowMs: FAST_WINDOW_MS,
    jitter: 0,
    random: () => 0
  }
  const at = (failures) => retryWait({ failures, downMs: 0, ...ladderOpts })
  const run = drive(t, url, await memberStorage(), {
    retryMinMs: ladderOpts.minMs,
    retryMaxMs: ladderOpts.maxMs,
    retryFastMaxMs: ladderOpts.fastMaxMs,
    retryFastWindowMs: ladderOpts.fastWindowMs,
    retryJitter: 0,
    restartWaitMs: 50,
    restartJitterMs: 0,
    random: () => 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return retrySeconds(run.lines).length >= 3
    }, { timeoutMs: 20000, name: 'three waits' })
    t.alike(retrySeconds(run.lines).slice(0, 3), [
      Math.ceil(restartWait({ waitMs: 50, jitterMs: 0 }) / 1000),
      Math.ceil(at(0) / 1000),
      Math.ceil(at(1) / 1000)
    ], 'restart wait once, then the retry ladder')
    t.ok(run.lines.filter((line) => line === RESTART_WARNING).length >= 2, 'every 1012 still warns')
    t.ok(eventIndex(run, 'seeder-restarting') !== -1, 'seeder-restarting still emitted')
  } finally {
    await stop(run)
  }
})

test('a verified link gets the quick redial again after a 1012', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  // Each verified link is closed with 1012 once the diary is admitted. With
  // a 1.2 s ladder minimum, a redial in under 1 s on both drops means the
  // verified hello re-armed the restart wait.
  const seeder = await fakeSeeder(t, assocKp, () => {
    for (const ws of seeder.connections) {
      if (ws.readyState === ws.OPEN) ws.close(1012, 'reiniciando')
    }
  })
  const run = drive(t, seeder.url, await memberStorage(assocKp), {
    retryMinMs: 1200,
    retryFastMaxMs: 5000,
    retryJitter: 0,
    restartWaitMs: 50,
    restartJitterMs: 0,
    random: () => 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return run.lines.filter((line) => line === RESTART_WARNING).length >= 2 && retrySeconds(run.lines).length >= 2
    }, { timeoutMs: 30000, name: 'two restarts' })
    t.alike(retrySeconds(run.lines).slice(0, 2), [1, 1], 'restart wait after each verified link')
  } finally {
    await stop(run)
  }
})

test('a plain close (1006) gives neither seeder-busy nor seeder-restarting', async (t) => {
  t.timeout(60000)
  await testnet(t)
  // terminate() drops the socket with no close frame: the client records 1006.
  const url = await closeServer(t, (ws) => ws.terminate())
  const run = drive(t, url, await memberStorage(), {
    retryMinMs: 400,
    retryFastMaxMs: 400,
    retryJitter: 0,
    restartWaitMs: 30,
    restartJitterMs: 0,
    random: () => 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return run.times.length >= 2 && eventIndex(run, 'link-closed') !== -1
    }, { timeoutMs: 15000, name: 'plain redial' })
    const gap = run.times[1] - run.times[0]
    t.ok(gap >= 300, 'ordinary retry, not the 30 ms restart, gap ' + gap + ' ms')
    t.is(eventIndex(run, 'seeder-busy'), -1)
    t.is(eventIndex(run, 'seeder-restarting'), -1)
    t.ok(!run.lines.includes(BUSY_WARNING), 'no busy warning')
    t.ok(!run.lines.includes(RESTART_WARNING), 'no restart warning')
    t.ok(retrySeconds(run.lines).length >= 1, 'retry warning kept')
  } finally {
    await stop(run)
  }
})

test('syncRun defaults cap the first wait at RETRY_FAST_MAX_MS', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const port = await deadPort()
  // The 6 s minimum would wait 6 s under the slow cap, 5 s under the fast one.
  const run = drive(t, 'ws://127.0.0.1:' + port + '/seeder', await memberStorage(), {
    retryMinMs: 6000,
    retryJitter: 0
  })
  try {
    await until(() => {
      if (run.failure) throw run.failure
      return retrySeconds(run.lines).length >= 1
    }, { timeoutMs: 30000, name: 'first wait' })
    t.alike(retrySeconds(run.lines)[0], RETRY_FAST_MAX_MS / 1000)
  } finally {
    await stop(run)
  }
})

test('a verified link restarts the fast window', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const port = await deadPort()
  const assocKp = generateAssociationKeyPair()
  const WINDOW = 1500
  // Dead until the window has passed, then the live seeder, then dead again.
  // After the drop the waits are 100, 200, then the cap: 200 when the window
  // restarted (downSince cleared), 400 and 800 when the old downSince stays.
  let phase = 'dead'
  const seeder = await fakeSeeder(t, assocKp, () => {
    if (phase !== 'live') return
    phase = 'dropped'
    for (const ws of seeder.connections) ws.terminate()
  })
  let first = 0
  const post = []
  const times = []
  const ac = new AbortController()
  t.teardown(() => ac.abort(), { force: true })
  let failure = null
  const done = runSync({
    storage: await memberStorage(assocKp),
    seederUrl: seeder.url,
    signal: ac.signal,
    startupSlowMs: 120000,
    retryMinMs: 100,
    retryFastMaxMs: 200,
    retryMaxMs: 3200,
    retryFastWindowMs: WINDOW,
    retryJitter: 0,
    log: () => {},
    createSocket: (url) => {
      const now = Date.now()
      times.push(now)
      if (!first) first = now
      if (phase === 'dead' && now - first > WINDOW) phase = 'live'
      if (phase === 'dropped') post.push(now)
      const target = phase === 'dead' || phase === 'dropped' ? 'ws://127.0.0.1:' + port + '/seeder' : url
      const ws = new WebSocket(target)
      ws.on('error', () => {})
      return ws
    }
  }).catch((err) => { failure = err })
  try {
    await until(() => {
      if (failure) throw failure
      return post.length >= 4
    }, { timeoutMs: 30000, name: 'dials after the drop' })
    const lastWait = post[3] - post[2]
    t.ok(lastWait < 600, 'fast cap after the link was verified, waited ' + lastWait + ' ms')
  } finally {
    ac.abort()
    await done
  }
})
