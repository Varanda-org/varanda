// scripts/dht-relay.js (spike G3): refuses to start without --port or
// without a private --bootstrap, and with both prints its listen lines and
// exits 0 on SIGINT. It refuses a non-loopback --host, answers a foreign
// Host header with 421 and a non-loopback Origin with 403, and terminates a
// WebSocket that stays silent past its deadlines. A second session listening with a key already in use
// is refused alone (the relay and the first session go on). The last tests
// cover lib/relay-link.js against a fake relay client: the announce is
// renewed on the refresh timer, a peer that never dials us is dialed after
// the grace period, and nothing is issued after the transport closed.
const test = require('brittle')
const EventEmitter = require('node:events')
const dgram = require('node:dgram')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { WebSocket } = require('ws')
const DHT = require('@hyperswarm/dht-relay')
const b4a = require('b4a')
const { testnet, until, bootstrapFlags } = require('./helpers/net')
const { createRelayedSwarm } = require('../lib/relay-link')

const RELAY = path.join(__dirname, '..', 'scripts', 'dht-relay.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function run (t, args, env = null) {
  const opts = { stdio: ['ignore', 'pipe', 'pipe'] }
  if (env) opts.env = { ...process.env, ...env }
  const child = spawn(process.execPath, [RELAY, ...args], opts)
  const proc = { child, stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(code) }))
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await proc.exited
    }
  }, { force: true })
  return proc
}

// A UDP socket standing in for a bootstrap node: any datagram on it means a
// DHT was constructed.
async function udpProbe (t) {
  const socket = dgram.createSocket('udp4')
  const received = []
  socket.on('message', (msg) => received.push(msg.length))
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => socket.close(resolve)), { force: true })
  return { bootstrap: '127.0.0.1:' + socket.address().port, received }
}

test('without --port: usage, exit 2, no listen line, no DHT', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const probe = await udpProbe(t)
  const proc = run(t, ['--bootstrap', probe.bootstrap, '--dht-host', '127.0.0.1'])
  t.is(await proc.exited, 2)
  t.is(proc.stdout, '', 'no listen line')
  t.ok(proc.stderr.includes('uso:'), 'usage on stderr')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(probe.received.length, 0, 'no DHT packet sent')
})

test('without --bootstrap: usage, exit 2, no listen line', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const proc = run(t, ['--port', '0'])
  t.is(await proc.exited, 2)
  t.is(proc.stdout, '', 'no listen line')
  t.ok(proc.stderr.includes('uso:'), 'usage on stderr')
})

for (const host of ['0.0.0.0', '192.168.1.10']) {
  test('non-loopback --host ' + host + ': usage, exit 2, no listen line', async (t) => {
    t.timeout(120000)
    const { bootstrap } = await testnet(t)
    const proc = run(t, ['--port', '0', '--host', host, ...bootstrapFlags(bootstrap)])
    t.is(await proc.exited, 2)
    t.is(proc.stdout, '', 'no listen line')
    t.ok(proc.stderr.includes('--host deve ser um endereço de loopback'), 'reason on stderr')
    t.ok(proc.stderr.includes('uso:'), 'usage on stderr')
  })
}

// Resolves the upgrade's outcome: 101 when the WebSocket opened, else the
// HTTP status the relay answered with.
function upgradeStatus (t, url, opts) {
  const ws = new WebSocket(url, opts)
  t.teardown(() => ws.terminate(), { force: true })
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.close()
      resolve(101)
    })
    ws.once('unexpected-response', (req, res) => {
      res.resume()
      resolve(res.statusCode)
      req.destroy()
    })
    ws.on('error', (err) => {
      if (ws.readyState !== WebSocket.CLOSED) reject(err)
    })
  })
}

test('Host and Origin checks: 421 for a foreign Host, 403 for a non-loopback Origin', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const proc = run(t, ['--port', '0', ...bootstrapFlags(bootstrap)])
  const line = await until(() => relayLine(proc), { name: 'linha do relay', timeoutMs: 20000 })
  const url = 'ws://127.0.0.1:' + line.port
  t.is(await upgradeStatus(t, url, { headers: { host: 'evil.example:' + line.port } }), 421, 'foreign Host on upgrade: 421')
  t.is(await upgradeStatus(t, url, { headers: { host: 'localhost:' + (line.port === 1 ? 2 : line.port - 1) } }), 421, 'wrong port in Host: 421')
  t.is(await upgradeStatus(t, url, { origin: 'https://evil.example' }), 403, 'foreign Origin: 403')
  t.is(await upgradeStatus(t, url, { origin: 'http://evil.example:8790' }), 403, 'http Origin on a foreign hostname: 403')
  t.is(await upgradeStatus(t, url, { origin: 'http://127.0.0.1:8790' }), 101, 'loopback http Origin accepted')
  t.is(await upgradeStatus(t, url, {}), 101, 'no Origin accepted')
  t.is(await upgradeStatus(t, url, { headers: { host: 'localhost:' + line.port } }), 101, 'localhost Host accepted')

  // Plain HTTP gets the same Host check before the 426.
  const plain = (host) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: line.port, headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
  })
  t.is(await plain('evil.example:' + line.port), 421, 'foreign Host on HTTP: 421')
  t.is(await plain('127.0.0.1:' + line.port), 426, 'loopback Host on HTTP: 426')

  proc.child.kill('SIGINT')
  t.is(await proc.exited, 0, 'SIGINT exits 0')
  t.is(proc.stdout.split('\n').filter(Boolean).length, 2, 'only the two listen lines')
  t.is(proc.stderr, '', 'nothing logged (no address)')
})

test('deadlines: a silent WebSocket is terminated; one that keeps sending stays open', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const proc = run(t, ['--port', '0', ...bootstrapFlags(bootstrap)], { VARANDA_RELAY_TEST_TIMEOUTS: '300,600' })
  const line = await until(() => relayLine(proc), { name: 'linha do relay', timeoutMs: 20000 })
  const url = 'ws://127.0.0.1:' + line.port

  const silent = await openSocket(t, url)
  const openedAt = Date.now()
  await new Promise((resolve) => silent.once('close', resolve))
  const elapsed = Date.now() - openedAt
  t.ok(elapsed < 1000, 'silent socket closed by the server within ~1 s (' + elapsed + ' ms)')

  // Empty frames are ignored by the relay protocol (protomux) but count as
  // inbound messages for the deadlines.
  const busy = await openSocket(t, url)
  const ticker = setInterval(() => busy.send(b4a.alloc(0)), 200)
  t.teardown(() => clearInterval(ticker), { force: true })
  busy.send(b4a.alloc(0))
  let closedEarly = false
  busy.once('close', () => { closedEarly = true })
  await sleep(1600)
  t.is(closedEarly, false, 'still open past 1.5 s')
  t.is(busy.readyState, WebSocket.OPEN)
  clearInterval(ticker)
  busy.removeAllListeners('close')
  const code = await new Promise((resolve) => {
    busy.once('close', (c) => resolve(c))
    busy.close(1000)
  })
  t.is(code, 1000, 'closed cleanly')

  // One message, then silence: terminated by the idle deadline.
  const quiet = await openSocket(t, url)
  quiet.send(b4a.alloc(0))
  const sentAt = Date.now()
  await new Promise((resolve) => quiet.once('close', resolve))
  const idle = Date.now() - sentAt
  t.ok(idle >= 500 && idle < 1500, 'idle socket terminated after ~600 ms (' + idle + ' ms)')

  proc.child.kill('SIGINT')
  t.is(await proc.exited, 0, 'SIGINT exits 0')
  t.is(proc.stderr, '', 'nothing logged (no address)')
})

test('with the testnet bootstrap: relay line, then SIGINT exits 0', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const proc = run(t, ['--port', '0', ...bootstrapFlags(bootstrap)])
  const line = await until(() => proc.stdout.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).find((e) => e && e.event === 'relay'), { name: 'linha do relay', timeoutMs: 20000 })
  t.is(line.host, '127.0.0.1', 'default host is loopback')
  t.ok(Number.isInteger(line.port) && line.port > 0)
  const lines = proc.stdout.split('\n').filter(Boolean)
  t.is(lines[0], 'dht-relay experimental (não usar em produção) ws://127.0.0.1:' + line.port)

  // A WebSocket client is accepted and its address is never logged.
  const ws = new WebSocket('ws://127.0.0.1:' + line.port)
  ws.on('error', () => {})
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.close()

  proc.child.kill('SIGINT')
  t.is(await proc.exited, 0, 'SIGINT exits 0')
  t.is(proc.stdout.split('\n').filter(Boolean).length, 2, 'only the two listen lines')
  t.is(proc.stderr, '')
})

function relayLine (proc) {
  return proc.stdout.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).find((e) => e && e.event === 'relay')
}

function openSocket (t, url) {
  const ws = new WebSocket(url)
  ws.on('error', () => {})
  t.teardown(() => ws.close(), { force: true })
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// A relayed query settles (its 'close' fires) only while the relay serves
// the session.
function settled (query) {
  return new Promise((resolve) => {
    query.on('error', () => {})
    query.once('close', () => resolve(true))
    query.resume()
  })
}

test('a second session with a key already in use is refused alone; the relay and the first session go on', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const proc = run(t, ['--port', '0', ...bootstrapFlags(bootstrap)])
  const line = await until(() => relayLine(proc), { name: 'linha do relay', timeoutMs: 20000 })
  const url = 'ws://127.0.0.1:' + line.port
  const keyPair = DHT.keyPair()
  const topic = b4a.alloc(32, 7)

  const first = createRelayedSwarm({ socket: await openSocket(t, url), keyPair })
  t.teardown(() => first.destroy(), { force: true })
  await first.join(topic)

  const second = createRelayedSwarm({ socket: await openSocket(t, url), keyPair })
  t.teardown(() => second.destroy(), { force: true })
  await t.exception(second.join(topic), /relay fechou a conexão antes de escutar/, 'the second session is refused')
  await until(() => proc.stderr.includes('sessão recusada: chave pública já em uso neste relay'), { name: 'motivo no stderr' })

  // The relay is still alive: a third WebSocket is accepted and the first
  // session still gets its queries answered.
  t.is(proc.code, null, 'relay process still running')
  const third = await openSocket(t, url)
  third.close()
  t.ok(await settled(first.dht.lookup(topic)), 'first session still served')
  t.is(first.connections.size, 0, 'no stray connection')

  proc.child.kill('SIGINT')
  t.is(await proc.exited, 0, 'SIGINT exits 0 (never terminated by the rejection)')
  t.is(proc.stdout.split('\n').filter(Boolean).length, 2, 'only the two listen lines')
  t.is(proc.stderr, 'sessão recusada: chave pública já em uso neste relay\n', 'only the refusal, no address')
})

// A fake relay client with the surface relay-link.js drives: counts every
// announce/lookup/connect, resolves listen at once, and lets the test feed
// lookup records.
function fakeDht (ownKey) {
  const dht = {
    defaultKeyPair: { publicKey: ownKey, secretKey: b4a.alloc(64) },
    announces: 0,
    lookups: [],
    connects: [],
    createServer () {
      const server = new EventEmitter()
      server.listen = async () => {}
      return server
    },
    announce () {
      dht.announces++
      return query()
    },
    lookup () {
      const q = query()
      dht.lookups.push(q)
      return q
    },
    connect (remote) {
      dht.connects.push(remote)
      const conn = new EventEmitter()
      conn.destroy = () => conn.emit('close')
      return conn
    },
    async destroy () {}
  }
  return dht

  function query () {
    const q = new EventEmitter()
    q.destroy = () => q.emit('close')
    return q
  }
}

function fakeSocket () {
  const socket = new EventEmitter()
  socket.addEventListener = (name, fn) => socket.on(name, fn)
  return socket
}

test('relay-link: the announce is renewed on the refresh timer', async (t) => {
  const dht = fakeDht(b4a.alloc(32, 0x80))
  const swarm = createRelayedSwarm({ socket: fakeSocket(), dht, refreshMs: 20, lookupMs: 20 })
  t.teardown(() => swarm.destroy(), { force: true })
  await swarm.join(b4a.alloc(32, 1))
  t.is(dht.announces, 1, 'one announce on join')
  await until(() => dht.announces >= 4, { name: 'reanúncio', timeoutMs: 5000 })
  t.ok(dht.lookups.length >= 2, 'lookups keep repeating too')
})

test('relay-link: a peer that should dial us is dialed after the grace period', async (t) => {
  const own = b4a.alloc(32, 0x80)
  const lower = b4a.alloc(32, 0x01)
  const higher = b4a.alloc(32, 0xff)
  const dht = fakeDht(own)
  const swarm = createRelayedSwarm({ socket: fakeSocket(), dht, refreshMs: 60000, lookupMs: 60000, graceMs: 50 })
  t.teardown(() => swarm.destroy(), { force: true })
  await swarm.join(b4a.alloc(32, 1))
  dht.lookups[0].emit('data', { peers: [{ publicKey: lower }, { publicKey: higher }] })
  t.alike(dht.connects, [lower], 'the lower key is dialed at once (we are the expected initiator)')
  await sleep(25)
  t.is(dht.connects.length, 1, 'the higher key waits for its own dial')
  await until(() => dht.connects.length === 2, { name: 'discagem após a carência', timeoutMs: 5000 })
  t.alike(dht.connects[1], higher, 'the higher key is dialed after the grace period')
  // A repeated record while already dialing does not dial twice.
  dht.lookups[0].emit('data', { peers: [{ publicKey: higher }] })
  await sleep(80)
  t.is(dht.connects.length, 2, 'no duplicate dial')
})

test('relay-link: nothing is issued after the transport closed; destroy stays idempotent', async (t) => {
  const dht = fakeDht(b4a.alloc(32, 0x80))
  const socket = fakeSocket()
  const swarm = createRelayedSwarm({ socket, dht, refreshMs: 20, lookupMs: 20, graceMs: 20 })
  t.teardown(() => swarm.destroy(), { force: true })
  await swarm.join(b4a.alloc(32, 1))
  await until(() => dht.announces >= 2 && dht.lookups.length >= 2, { name: 'temporizadores ativos', timeoutMs: 5000 })
  // A discovered higher key has a pending grace dial that must be dropped.
  dht.lookups[0].emit('data', { peers: [{ publicKey: b4a.alloc(32, 0xff) }] })
  socket.emit('close')
  const announces = dht.announces
  const lookups = dht.lookups.length
  await sleep(20 * 3 + 30)
  t.is(dht.announces, announces, 'no announce after close (3 refresh periods)')
  t.is(dht.lookups.length, lookups, 'no lookup after close (3 refresh periods)')
  t.is(dht.connects.length, 0, 'the pending grace dial was dropped')
  await t.exception(swarm.join(b4a.alloc(32, 2)), /relay desconectado/, 'join refuses a closed transport')
  await swarm.destroy()
  await swarm.destroy()
  t.pass('destroy is idempotent')
})

test('relay-link: custodial mode is refused without the diagnostic flag', async (t) => {
  t.exception(() => createRelayedSwarm({ socket: fakeSocket(), custodial: true }), /modo custodial recusado/)
  t.exception(() => createRelayedSwarm({ socket: fakeSocket(), dht: fakeDht(b4a.alloc(32, 0x80)), custodial: true }), /modo custodial recusado/, 'even with a fake client')
  const swarm = createRelayedSwarm({ socket: fakeSocket(), dht: fakeDht(b4a.alloc(32, 0x80)) })
  t.is(swarm.custody, 'noncustodial', 'the default stays noncustodial')
  await swarm.destroy()
})
