// The WebSocket listener across a seeder restart: drain() stops listening
// (a new dial is refused, which Caddy retries) and closes the app clients
// with 1012 'reiniciando' before the seeder shuts down (and `seed` does it
// on SIGTERM), and startHoldMs holds a /seeder upgrade while the seeder
// starts instead of answering 503 at once.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const b4a = require('b4a')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { startSeedWs } = require('../lib/seed-ws')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

const UPGRADE = 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'

// An unmasked server close frame: FIN + opcode 8, length 13, code 1012, 'reiniciando'.
const CLOSE_1012 = Buffer.concat([Buffer.from([0x88, 0x0d, 0x03, 0xf4]), Buffer.from('reiniciando')])

function within (promise, ms, name) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(name + ' não terminou em ' + ms + ' ms')), ms) })
  ]).finally(() => clearTimeout(timer))
}

// A stub seeder: stats() reports status (and counts its calls); acceptStream
// keeps the stream and, with `chatty`, writes to it every 10 ms as a live
// replication would, so a drain must cope with the seeder still writing.
function stubSeeder (status = 'ok', { chatty = false } = {}) {
  const stub = { status, statsCalls: 0, streams: [] }
  stub.stats = () => {
    stub.statsCalls++
    return { status: stub.status }
  }
  stub.acceptStream = (duplex) => {
    stub.streams.push(duplex)
    duplex.on('error', () => {})
    if (chatty) {
      const timer = setInterval(() => { if (!duplex.destroyed) duplex.write(Buffer.from('x')) }, 10)
      duplex.once('close', () => clearInterval(timer))
    }
    return {}
  }
  return stub
}

async function listen (t, opts) {
  const server = await startSeedWs({ port: 0, ...opts })
  t.teardown(() => server.close(), { force: true })
  return server
}

// Opens a WebSocket on /seeder; resolves { ws, closed } once open, closed
// resolving { code, reason } on the client's close event.
function openSeederWs (t, port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder')
  ws.on('error', () => {})
  t.teardown(() => ws.terminate(), { force: true })
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  return within(new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, closed }))
    ws.once('unexpected-response', () => reject(new Error('upgrade recusado')))
  }), 5000, 'open')
}

// Opens a WebSocket on /seeder with the given headers; resolves { status, ms }
// where status is the HTTP status of a refused upgrade, or 'open'.
function upgrade (t, port, headers = {}, timeoutMs = 10000) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder', { headers })
  t.teardown(() => ws.terminate(), { force: true })
  const start = Date.now()
  return within(new Promise((resolve) => {
    ws.once('unexpected-response', (req, res) => { res.resume(); resolve({ status: res.statusCode, ms: Date.now() - start }) })
    ws.once('open', () => resolve({ status: 'open', ms: Date.now() - start }))
    ws.on('error', () => {})
  }), timeoutMs, 'upgrade')
}

// A new TCP connection to the port: resolves 'refused' on ECONNREFUSED,
// 'connected' otherwise.
function dial (t, port) {
  return within(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    t.teardown(() => socket.destroy(), { force: true })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', (err) => err.code === 'ECONNREFUSED' ? resolve('refused') : reject(err))
  }), 5000, 'dial')
}

// A TCP connection opened now that sends a /seeder upgrade only when
// send() is called; send() resolves the first line of the answer. It
// resolves 200 ms after the client side connects: a connection the server
// has not accepted yet is reset when the server stops listening.
function laterUpgrade (t, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    t.teardown(() => socket.destroy(), { force: true })
    socket.on('error', () => {})
    socket.once('error', reject)
    socket.once('connect', () => setTimeout(resolve, 200, {
      send: () => within(new Promise((resolve) => {
        let bytes = ''
        socket.on('data', (d) => {
          bytes += d
          if (bytes.includes('\r\n')) resolve(bytes.split('\r\n')[0])
        })
        socket.write('GET /seeder HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n' + UPGRADE)
      }), 5000, 'resposta do upgrade')
    }))
  })
}

// A raw client that sends a /seeder upgrade and then stays silent: it never
// answers a close frame. response() is what it received; closed resolves
// once the server drops the connection.
function rawUpgrade (t, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    t.teardown(() => socket.destroy(), { force: true })
    let bytes = Buffer.alloc(0)
    let closeAt = null
    socket.on('data', (d) => {
      bytes = Buffer.concat([bytes, d])
      if (closeAt === null && bytes.includes(CLOSE_1012)) closeAt = Date.now()
    })
    socket.on('error', () => {})
    const closed = new Promise((resolve) => socket.once('close', () => resolve(closeAt === null ? -1 : Date.now() - closeAt)))
    socket.once('connect', () => {
      socket.write('GET /seeder HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n' + UPGRADE)
      resolve({ socket, closed, bytes: () => bytes })
    })
    socket.once('error', reject)
  })
}

test('drain: an open client is closed with 1012 reiniciando', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('ok', { chatty: true }) })
  const client = await openSeederWs(t, server.port)
  await until(() => client.ws.readyState === WebSocket.OPEN)
  const drained = server.drain()
  t.alike(await within(client.closed, 1500, 'close do cliente'), { code: 1012, reason: 'reiniciando' })
  await within(drained, 1500, 'drain()')
  t.pass('drain() resolved within the grace')
})

test('drain: the port stops listening at once, while an open client still gets 1012', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('ok', { chatty: true }) })
  t.is(await dial(t, server.port), 'connected', 'the port listens before drain()')
  const client = await openSeederWs(t, server.port)
  // A silent client keeps drain() pending for its grace.
  const raw = await rawUpgrade(t, server.port)
  await until(() => client.ws.readyState === WebSocket.OPEN && raw.bytes().length > 0)
  let done = false
  const drained = server.drain().then(() => { done = true })
  t.is(await dial(t, server.port), 'refused', 'a new dial during the drain is refused (ECONNREFUSED)')
  t.absent(done, 'refused while drain() was still pending')
  t.alike(await within(client.closed, 1500, 'close do cliente'), { code: 1012, reason: 'reiniciando' })
  await within(drained, 3000, 'drain()')
  t.ok(raw.bytes().includes(CLOSE_1012), 'the silent client got 1012 reiniciando too')
  await within(server.close(), 3000, 'close() after drain()')
  t.pass('close() after drain() resolved')
})

test('drain: a client that never answers the close gets 1012 and is terminated after the grace', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok', { chatty: true })
  const server = await listen(t, { seeder })
  const raw = await rawUpgrade(t, server.port)
  // The seeder is writing: data frames reach the client before the drain.
  await until(() => raw.bytes().length > 200, { name: 'dados do semeador' })
  const drained = within(server.drain(), 3000, 'drain()')
  const heldMs = await within(raw.closed, 5000, 'close do cliente mudo')
  await drained
  const bytes = raw.bytes()
  const at = bytes.indexOf(CLOSE_1012)
  t.ok(at > 0, 'the close frame 1012 reiniciando arrived after the data frames')
  t.is(bytes.length, at + CLOSE_1012.length, 'no data frame after the close frame')
  // A seeder write on the CLOSING socket would have made the stream
  // terminate it at once, right after the close frame.
  t.ok(heldMs >= 500, 'the server waited for the close handshake (' + heldMs + ' ms)')
  t.ok(heldMs < 3000, 'and terminated the socket after the grace')
  t.ok(seeder.streams[0].destroyed, 'the stream handed to the seeder is destroyed')
})

test('drain: an upgrade on a connection open before drain() gets 503; drain() twice and close() after it resolve', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('ok') })
  const client = await openSeederWs(t, server.port)
  const early = await laterUpgrade(t, server.port)
  const first = server.drain()
  t.is(server.drain(), first, 'a second drain() returns the same promise')
  await within(first, 3000, 'drain()')
  t.is((await client.closed).code, 1012)
  t.is(await early.send(), 'HTTP/1.1 503 Service Unavailable', 'an upgrade while draining answers 503')
  t.is(await dial(t, server.port), 'refused', 'a new dial is refused')
  await within(server.drain(), 1000, 'drain() again')
  await within(server.close(), 3000, 'close() after drain()')
  t.pass('close() after drain() resolved')
})

test('drain: with no client it resolves at once', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('ok') })
  await within(server.drain(), 500, 'drain() sem clientes')
  t.pass()
})

// The seed data dir: config, Noise key pair and seeder certificate.
function prepareSeederDir (t) {
  const kp = generateAssociationKeyPair()
  const assoc = b4a.toString(kp.publicKey, 'hex')
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, kp)))
  Seeder.addCert(dataDir, certFile, assoc)
  return dataDir
}

// `seed --json` as a child process; event(name) waits for a stdout JSON event.
function seedProcess (t, dataDir, args) {
  const child = spawn(process.execPath, [BIN, 'seed', '--json', '--data', dataDir, ...args], { env })
  const proc = { child, stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(code) }))
  proc.events = () => proc.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  proc.event = (name) => until(() => proc.events().find((e) => e.event === name), { name: 'evento ' + name, timeoutMs: 30000 })
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await proc.exited
    }
  }, { force: true })
  return proc
}

test('seed: SIGTERM closes an app client with 1012 reiniciando, not 1006', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const proc = seedProcess(t, prepareSeederDir(t), ['--ws-port', '0', ...bootstrapFlags(bootstrap)])
  const { port } = await proc.event('ws')
  await proc.event('ready')

  const { ws, closed } = await openSeederWs(t, port)
  const duplex = createWebSocketStream(ws)
  duplex.on('error', () => {})
  const noise = new NoiseSecretStream(true, duplex, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await within(new Promise((resolve, reject) => {
    noise.once('connect', resolve)
    noise.once('close', () => reject(new Error('stream fechado antes do handshake')))
  }), 10000, 'handshake Noise')

  proc.child.kill('SIGTERM')
  t.alike(await within(closed, 5000, 'close do cliente'), { code: 1012, reason: 'reiniciando' })
  t.is(await within(proc.exited, 30000, 'saída do seed'), 0, 'seed exits 0')
})

test('hold: an upgrade while starting is accepted once the seeder is ready', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('starting')
  const server = await listen(t, { seeder, startHoldMs: 2000 })
  const timer = setTimeout(() => { seeder.status = 'ok' }, 300)
  t.teardown(() => clearTimeout(timer))
  const { status } = await upgrade(t, server.port)
  t.is(status, 'open', 'held, then accepted')
  if (status !== 'open') return
  await until(() => seeder.streams.length === 1, { name: 'stream entregue' })
  t.pass('the stream reached the seeder')
})

test('hold: a held upgrade is accepted once accepting() turns true, while the status stays starting', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('starting')
  let accepting = false
  seeder.accepting = () => accepting
  const server = await listen(t, { seeder, startHoldMs: 3000 })
  const timer = setTimeout(() => { accepting = true }, 300)
  t.teardown(() => clearTimeout(timer))
  const { status } = await upgrade(t, server.port)
  t.is(status, 'open', 'held, then accepted')
  t.is(seeder.status, 'starting', 'the status never turned ok')
  if (status !== 'open') return
  await until(() => seeder.streams.length === 1, { name: 'stream entregue' })
  t.pass('the stream reached the seeder')
})

test('hold: a seeder that never gets ready answers 503 after the hold', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('starting'), startHoldMs: 600 })
  const { status, ms } = await upgrade(t, server.port)
  t.is(status, 503)
  t.ok(ms >= 500, 'held for the hold first (' + ms + ' ms)')
})

test('hold: startHoldMs 0 answers 503 at once', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('starting') })
  const { status, ms } = await upgrade(t, server.port, {}, 2000)
  t.is(status, 503)
  t.ok(ms < 2000)
})

test('hold: a status other than starting is not held', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('closing'), startHoldMs: 30000 })
  t.is((await upgrade(t, server.port, {}, 5000)).status, 503)
})

test('hold: beyond maxExternal held upgrades, 503 at once; a held one is accepted when ready', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('starting')
  seeder.maxExternal = 1
  const server = await listen(t, { seeder, startHoldMs: 30000 })
  const first = await rawUpgrade(t, server.port)
  // ready() and starting() each read stats() once before the hold starts.
  await until(() => seeder.statsCalls >= 2, { name: 'primeiro upgrade segurado' })
  t.is((await upgrade(t, server.port, {}, 5000)).status, 503, 'the second upgrade is refused at once')
  seeder.status = 'ok'
  await until(() => first.bytes().toString().startsWith('HTTP/1.1 101'), { name: 'primeiro aceito', timeoutMs: 5000 })
  t.pass('the held upgrade was accepted')
})

test('hold: a held client that goes away frees its place', async (t) => {
  t.timeout(30000)
  const seeder = stubSeeder('starting')
  seeder.maxExternal = 1
  const server = await listen(t, { seeder, startHoldMs: 30000 })
  const first = await rawUpgrade(t, server.port)
  await until(() => seeder.statsCalls >= 2, { name: 'primeiro upgrade segurado' })
  first.socket.resetAndDestroy()
  // Until the server sees the reset, a new upgrade is refused at once; then
  // one is held again (no answer while the seeder starts).
  let held = null
  await until(async () => {
    const probe = await rawUpgrade(t, server.port)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (probe.bytes().length === 0) {
      held = probe
      return true
    }
    probe.socket.destroy()
    return false
  }, { name: 'novo upgrade segurado', timeoutMs: 20000 })
  seeder.status = 'ok'
  await until(() => held.bytes().toString().startsWith('HTTP/1.1 101'), { name: 'aceito', timeoutMs: 5000 })
  t.pass('a new upgrade took the freed place and was accepted')
})

test('hold: a bad Host or Origin is refused at once, never held', async (t) => {
  t.timeout(20000)
  const server = await listen(t, { seeder: stubSeeder('starting'), startHoldMs: 30000, origins: ['http://ok.test'] })
  const origin = await upgrade(t, server.port, { Origin: 'http://evil.test' }, 5000)
  t.is(origin.status, 403)
  const host = await upgrade(t, server.port, { Origin: 'http://ok.test', Host: 'evil.test:' + server.port }, 5000)
  t.is(host.status, 421)
})

test('hold: no hold while draining; drain() and close() drop held upgrades', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('starting')
  const server = await listen(t, { seeder, startHoldMs: 30000 })
  const held = await rawUpgrade(t, server.port)
  await until(() => seeder.statsCalls >= 2, { name: 'upgrade segurado' })
  const early = await laterUpgrade(t, server.port)
  await within(server.drain(), 2000, 'drain()')
  await within(held.closed, 2000, 'close do upgrade segurado')
  t.is(held.bytes().length, 0, 'the held upgrade was dropped with no answer')
  t.is(await early.send(), 'HTTP/1.1 503 Service Unavailable', 'no hold while draining')

  const otherSeeder = stubSeeder('starting')
  const other = await listen(t, { seeder: otherSeeder, startHoldMs: 30000 })
  const second = await rawUpgrade(t, other.port)
  await until(() => otherSeeder.statsCalls >= 2, { name: 'segundo upgrade segurado' })
  await within(other.close(), 3000, 'close()')
  await within(second.closed, 2000, 'close do segundo upgrade segurado')
  t.pass('close() dropped the held upgrade and resolved')
})

test('readiness: accepting() decides when the seeder has it, else the status', async (t) => {
  t.timeout(20000)
  const accepting = stubSeeder('starting')
  accepting.accepting = () => true
  const a = await listen(t, { seeder: accepting })
  t.is((await upgrade(t, a.port, {}, 5000)).status, 'open', 'accepting() true while starting: accepted at once')

  const notYet = stubSeeder('ok')
  notYet.accepting = () => false
  const b = await listen(t, { seeder: notYet })
  t.is((await upgrade(t, b.port, {}, 5000)).status, 503, 'accepting() false wins over status ok')

  const legacy = stubSeeder('ok')
  t.is(legacy.accepting, undefined)
  const c = await listen(t, { seeder: legacy })
  t.is((await upgrade(t, c.port, {}, 5000)).status, 'open', 'without accepting(): status ok accepted')
  legacy.status = 'starting'
  t.is((await upgrade(t, c.port, {}, 5000)).status, 503, 'without accepting(): status starting refused')
})
