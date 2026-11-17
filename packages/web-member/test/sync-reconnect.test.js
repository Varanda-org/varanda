'use strict'

// Re-dial after the seeder drops. retryWait is the pure backoff: inside the
// fast window the cap is 5 s and each wait is shortened by up to a quarter,
// so a redeploy is redialled quickly and clients retry at different times.
// retryFastWindowMs 0 is the doubling ladder. A closed TCP port must be
// dialled at least 12 times within 10 s (the old 1, 2, 4 ... 30 s ladder
// reaches its 12th dial only after about 20 s when the minimum is 10 ms).
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
const { runSync, retryWait, RETRY_FAST_MAX_MS, RETRY_FAST_WINDOW_MS, RETRY_JITTER } = require('../lib/sync')
const ops = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')

const FAST_MAX_MS = 5000
const FAST_WINDOW_MS = 180000
const RETRY_WARNING = /^aviso: sem conexão com o semeador; nova tentativa em (\d+) s$/
const BUSY_WARNING = 'aviso: semeador ocupado; tente novamente em instantes'

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

// Starts a continuous run and records every dial and log line. The returned
// done promise settles with a rejection stored on the handle, so a startup
// failure surfaces from until() instead of as an unhandled rejection.
function drive (t, seederUrl, storage, opts = {}) {
  const times = []
  const lines = []
  const handle = { times, lines, failure: null, ac: new AbortController(), done: null }
  t.teardown(() => handle.ac.abort(), { force: true })
  handle.done = runSync({
    storage,
    seederUrl,
    signal: handle.ac.signal,
    startupSlowMs: 120000,
    ...opts,
    log: (line) => lines.push(line),
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
