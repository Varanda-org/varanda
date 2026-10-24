// The WebSocket entry of `seed --ws-port` (a phase 0 spike): a member over a
// WebSocket replicates through the seeder, plus the HTTP surface and flags.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { Seeder, MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair, seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission, generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord } = require('@varanda/core/lib/records')
const { startSeedWs, MAX_PAYLOAD } = require('../lib/seed-ws')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v
delete env.VARANDA_BOOTSTRAP
delete env.VARANDA_DHT_HOST

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A seeder data dir with config, Noise key pair and seeder certificate.
function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

// `seed --json` as a child process; lines are its stdout JSON events.
function seedProcess (t, dataDir, args, extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, 'seed', '--json', '--data', dataDir, ...args], { env: { ...env, ...extraEnv } })
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

function request (port, method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('seed --ws-port: a member over a WebSocket is admitted and the seeder proves itself', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const proc = seedProcess(t, dataDir, ['--ws-port', '0', ...bootstrapFlags(bootstrap)])

  const wsEvent = await proc.event('ws')
  t.is(wsEvent.host, '127.0.0.1')
  t.ok(wsEvent.port > 0, 'port chosen by the system')
  await proc.event('ready')
  const lines = proc.events().map((e) => e.event)
  t.ok(lines.indexOf('ws') < lines.indexOf('ready'), 'ws line precedes ready')

  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  await core.append(postRecord({ text: 'x' }))

  const ws = new WebSocket('ws://127.0.0.1:' + wsEvent.port + '/seeder')
  ws.on('error', () => {})
  t.teardown(() => ws.terminate(), { force: true })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const duplex = createWebSocketStream(ws)
  duplex.on('error', () => {})
  const noise = new NoiseSecretStream(true, duplex, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  const messages = []
  const peer = await new Promise((resolve, reject) => {
    noise.once('close', () => reject(new Error('stream fechado antes do handshake')))
    noise.once('connect', () => {
      store.replicate(noise)
      resolve(attachAdmission(noise, {
        role: 'member',
        have: [{ key, length: core.length }],
        onmessage: (msg) => messages.push(msg)
      }))
    })
  })

  const hello = await peer.hello
  t.ok(hello, 'hello received')
  t.is(hello.role, 'seeder')
  t.is(hex(noise.remotePublicKey), publicKey, 'Noise responder keyed with seeder-key.json')
  t.is(seederCertForKey(hello.cert, hex(noise.remotePublicKey), assoc.hex).ok, true)

  peer.send({ type: 'announce', key, cert: createCert({ member: key }, assoc.kp) })
  await until(() => messages.find((m) => m.type === 'admitted' && m.key === key), { name: 'admitted', timeoutMs: 20000 })
  await until(() => proc.events().find((e) => e.event === 'have' && e.key === key && e.length === 2), { name: 'have 2', timeoutMs: 20000 })
  t.ok(proc.stdout.includes('"key":"' + key + '"'))

  proc.child.kill('SIGTERM')
  t.is(await proc.exited, 0, 'SIGTERM exits 0')
  t.is(proc.stderr, '')
})

test('seed without --ws-port prints no ws line', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const proc = seedProcess(t, dataDir, bootstrapFlags(bootstrap))
  await proc.event('ready')
  t.absent(proc.events().some((e) => e.event === 'ws'), 'no ws event')
  proc.child.kill('SIGTERM')
  t.is(await proc.exited, 0)
})

test('seed --ws-port: only /seeder upgrades, other requests are refused without CORS', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const proc = seedProcess(t, dataDir, ['--ws-port', '0', ...bootstrapFlags(bootstrap)])
  const { port } = await proc.event('ws')
  await proc.event('ready')

  const other = new WebSocket('ws://127.0.0.1:' + port + '/other')
  t.teardown(() => other.terminate(), { force: true })
  const status = await new Promise((resolve) => {
    other.once('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode) })
    other.once('open', () => resolve('open'))
    other.once('error', () => {})
  })
  t.is(status, 404, 'upgrade on /other refused')

  const root = await request(port, 'GET', '/some/path?x=1')
  t.is(root.status, 404)
  t.is(root.body, 'não encontrado\n')
  t.is(root.headers['access-control-allow-origin'], undefined, 'no CORS header')
  t.is(root.headers['cache-control'], 'no-store')
  t.is(root.headers['x-content-type-options'], 'nosniff')
  t.absent(root.body.includes('some'), 'the URL is never echoed')

  const plain = await request(port, 'GET', '/seeder')
  t.is(plain.status, 426, 'GET /seeder without an upgrade')
  t.is(plain.headers['access-control-allow-origin'], undefined)

  proc.child.kill('SIGTERM')
  t.is(await proc.exited, 0)
})

test('--ws-port and VARANDA_WS_PORT are validated as usage errors', async (t) => {
  await testnet(t)
  const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 })
  const flag = run(['seed', '--ws-port', 'abc'])
  t.is(flag.status, 2)
  t.ok(flag.stderr.includes('ws-port inválido'))
  const variable = run(['seed'], { VARANDA_WS_PORT: 'abc' })
  t.is(variable.status, 2)
  t.ok(variable.stderr.includes('ws-port inválido'))
  const host = run(['seed', '--ws-port', '0', '--ws-host', 'bad host'])
  t.is(host.status, 2)
  t.ok(host.stderr.includes('ws-host inválido'))
})

// A stub seeder for startSeedWs: stats() reports status, and acceptStream
// counts the bytes that reach the raw stream.
function stubSeeder (status = 'ok') {
  const stub = { status, received: 0, streams: [] }
  stub.stats = () => ({ status: stub.status })
  stub.acceptStream = (duplex) => {
    stub.streams.push(duplex)
    duplex.on('data', (chunk) => { stub.received += chunk.byteLength })
    return {}
  }
  return stub
}

// A raw client that sends an upgrade request and NEVER ends its side
// (allowHalfOpen); resolves { socket, closed, response } where closed
// resolves with the elapsed ms once the connection is gone. The server's FIN
// alone ('end') does not prove the socket was destroyed (end() sends it too),
// so after 'end' the client keeps writing: a server socket that was only
// ended still accepts those bytes, one that was destroyed answers with a
// reset, which closes the client.
function halfOpenUpgrade (port, url, { host = '127.0.0.1:' + port, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    let response = ''
    let probe = null
    socket.setEncoding('utf8')
    socket.on('data', (d) => { response += d })
    socket.on('error', () => {})
    socket.once('end', () => {
      probe = setInterval(() => { if (!socket.destroyed) socket.write('x') }, 50)
    })
    const start = Date.now()
    const closed = new Promise((resolve) => socket.once('close', () => {
      clearInterval(probe)
      resolve(Date.now() - start)
    }))
    socket.once('connect', () => {
      socket.write('GET ' + url + ' HTTP/1.1\r\nHost: ' + host + '\r\n' + (origin === null ? '' : 'Origin: ' + origin + '\r\n') +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      resolve({ socket, closed, response: () => response })
    })
    socket.once('error', reject)
  })
}

function within (promise, ms, name) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(name + ' não terminou em ' + ms + ' ms')), ms) })
  ]).finally(() => clearTimeout(timer))
}

test('startSeedWs: refused upgrades are closed even if the client never ends its side', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('starting')
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })

  const other = await halfOpenUpgrade(ws.port, '/other')
  t.teardown(() => other.socket.destroy(), { force: true })
  const otherMs = await within(other.closed, 2000, 'close de /other')
  t.ok(otherMs < 2000, '/other closed by the server')
  t.ok(other.response().startsWith('HTTP/1.1 404'), '/other answered 404')
  t.ok(other.socket.destroyed, '/other socket destroyed')

  const early = await halfOpenUpgrade(ws.port, '/seeder')
  t.teardown(() => early.socket.destroy(), { force: true })
  const earlyMs = await within(early.closed, 2000, 'close de /seeder antes de pronto')
  t.ok(earlyMs < 2000, '/seeder before ready closed by the server')
  t.ok(early.response().startsWith('HTTP/1.1 503'), '/seeder before ready answered 503')
  t.ok(early.socket.destroyed, '/seeder socket destroyed')
})

test('startSeedWs: close() resolves while a half-open client is connected', async (t) => {
  t.timeout(20000)
  const ws = await startSeedWs({ port: 0, seeder: stubSeeder('starting') })
  t.teardown(() => ws.close(), { force: true })
  // A request whose headers never finish stays in the HTTP server, and one
  // refused upgrade is caught right after the 'upgrade' event.
  // Not half-open: this client stands for an unfinished request, so it closes
  // as soon as the server ends the connection (the /other client below covers
  // a client that keeps its side open).
  const partial = net.connect({ host: '127.0.0.1', port: ws.port })
  partial.on('error', () => {})
  t.teardown(() => partial.destroy(), { force: true })
  await new Promise((resolve) => partial.once('connect', resolve))
  partial.write('GET /seeder HTTP/1.1\r\nHost: 127.0.0.1:' + ws.port + '\r\n')
  const other = await halfOpenUpgrade(ws.port, '/other')
  t.teardown(() => other.socket.destroy(), { force: true })
  const partialClosed = new Promise((resolve) => partial.once('close', resolve))
  await within(ws.close(), 2000, 'close()')
  t.pass('close() resolved within 2000 ms')
  await within(partialClosed, 2000, 'close do cliente parcial')
  await within(other.closed, 2000, 'close do cliente /other')
})

test('startSeedWs: maxPayload follows the frame guard (a 2 MiB message reaches the seeder)', async (t) => {
  t.timeout(60000)
  t.ok(MAX_PAYLOAD >= MAX_EXTERNAL_FRAME + 3, 'maxPayload is at least a full guarded frame')
  const seeder = stubSeeder('ok')
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const open = (url) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('error', () => {})
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', () => reject(new Error('upgrade recusado')))
  })

  const ws = await open('ws://127.0.0.1:' + server.port + '/seeder')
  t.teardown(() => ws.terminate(), { force: true })
  let closeCode = null
  ws.on('close', (code) => { closeCode = code })
  const size = 2 * 1024 * 1024
  ws.send(b4a.alloc(size, 1))
  await until(() => seeder.received >= size, { name: '2 MiB recebidos', timeoutMs: 20000 })
  t.ok(seeder.received >= size, 'the seeder received the whole 2 MiB message')
  t.is(closeCode, null, 'the client was not closed (no 1009)')
  t.is(ws.readyState, WebSocket.OPEN)

  const big = await open('ws://127.0.0.1:' + server.port + '/seeder')
  t.teardown(() => big.terminate(), { force: true })
  const code = new Promise((resolve) => big.once('close', (c) => resolve(c)))
  big.send(b4a.alloc(MAX_PAYLOAD + 1, 1))
  t.is(await within(code, 20000, 'close acima de maxPayload'), 1009, 'a message above maxPayload is closed with 1009')
})

test('startSeedWs: a WebSocket closed by the client destroys the stream handed to the seeder', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok')
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/seeder')
  ws.on('error', () => {})
  t.teardown(() => ws.terminate(), { force: true })
  await within(new Promise((resolve) => ws.once('open', resolve)), 5000, 'open')
  await within(new Promise((resolve) => {
    const check = () => (seeder.streams.length === 1 ? resolve() : setTimeout(check, 10))
    check()
  }), 5000, 'stream entregue ao semeador')
  const duplex = seeder.streams[0]
  const gone = new Promise((resolve) => duplex.once('close', resolve))
  ws.close()
  await within(gone, 2000, 'close do duplex')
  t.ok(duplex.destroyed, 'the duplex is destroyed, so the seeder frees the slot')
})

// Opens a WebSocket on /seeder with the given extra headers; resolves the
// HTTP status of a refused upgrade, or 'open'.
function upgradeStatus (t, port, headers = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder', { headers })
  t.teardown(() => ws.terminate(), { force: true })
  return within(new Promise((resolve) => {
    ws.once('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode) })
    ws.once('open', () => resolve('open'))
    ws.on('error', () => {})
  }), 5000, 'upgrade')
}

test('startSeedWs: a Host that does not name the listener is refused with 421 (DNS rebinding)', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok')
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const evil = await halfOpenUpgrade(server.port, '/seeder', { host: 'evil.example:' + server.port })
  t.teardown(() => evil.socket.destroy(), { force: true })
  await within(evil.closed, 2000, 'close do Host inválido')
  t.ok(evil.response().startsWith('HTTP/1.1 421'), 'answered 421')
  t.ok(evil.socket.destroyed, 'socket destroyed')
  t.is(seeder.streams.length, 0, 'nothing handed to the seeder')

  const wrongPort = await halfOpenUpgrade(server.port, '/seeder', { host: '127.0.0.1:1' })
  t.teardown(() => wrongPort.socket.destroy(), { force: true })
  await within(wrongPort.closed, 2000, 'close da porta errada')
  t.ok(wrongPort.response().startsWith('HTTP/1.1 421'), 'another port answered 421')

  const plain = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: '/seeder', headers: { Host: 'evil.example:' + server.port } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  t.is(plain, 421, 'plain HTTP with a foreign Host answered 421')

  for (const name of ['localhost', '127.0.0.1', '[::1]']) {
    t.is(await upgradeStatus(t, server.port, { Host: name + ':' + server.port }), 'open', name + ' accepted on a loopback bind')
  }
})

test('startSeedWs: browser origins are allow-listed (loopback by default), Origin-less clients accepted', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok')
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  t.is(await upgradeStatus(t, server.port, { Origin: 'https://evil.example' }), 403, 'public origin refused')
  t.is(await upgradeStatus(t, server.port, { Origin: 'null' }), 403, "'null' origin refused")
  t.is(await upgradeStatus(t, server.port, { Origin: 'https://127.0.0.1:8790' }), 403, 'https loopback is not in the default list')
  t.is(seeder.streams.length, 0, 'refused origins never reach the seeder')

  const refused = await halfOpenUpgrade(server.port, '/seeder', { origin: 'https://evil.example' })
  t.teardown(() => refused.socket.destroy(), { force: true })
  await within(refused.closed, 2000, 'close da origem recusada')
  t.ok(refused.response().startsWith('HTTP/1.1 403'), 'answered 403')
  t.ok(refused.socket.destroyed, 'socket destroyed')

  t.is(await upgradeStatus(t, server.port, { Origin: 'http://127.0.0.1:8790' }), 'open', 'loopback spike origin accepted')
  t.is(await upgradeStatus(t, server.port, { Origin: 'http://localhost:5173' }), 'open', 'localhost origin accepted')
  t.is(await upgradeStatus(t, server.port), 'open', 'no Origin accepted')
  await until(() => seeder.streams.length === 3, { name: 'três streams entregues', timeoutMs: 5000 })
  t.is(seeder.streams.length, 3, 'accepted upgrades are handed to the seeder')
})

test('startSeedWs: an explicit origins list replaces the loopback default', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok')
  const server = await startSeedWs({ port: 0, seeder, origins: ['https://app.example'] })
  t.teardown(() => server.close(), { force: true })

  t.is(await upgradeStatus(t, server.port, { Origin: 'https://app.example' }), 'open', 'configured origin accepted')
  t.is(await upgradeStatus(t, server.port, { Origin: 'http://127.0.0.1:8790' }), 403, 'loopback origin refused when not listed')
  t.is(await upgradeStatus(t, server.port, { Origin: 'https://app.example:8443' }), 403, 'another port of the origin refused')
  t.is(await upgradeStatus(t, server.port), 'open', 'no Origin still accepted')
})

test('seed --ws-origin: the listed browser origins replace the loopback default; Host rewritten by a proxy is accepted', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const proc = seedProcess(t, dataDir, ['--ws-port', '0', '--ws-origin', 'https://app.example', ...bootstrapFlags(bootstrap)], { VARANDA_WS_ORIGIN: 'https://ignored.example' })
  const { port } = await proc.event('ws')
  await proc.event('ready')

  t.is(await upgradeStatus(t, port, { Origin: 'https://app.example' }), 'open', 'the listed origin is accepted')
  t.is(await upgradeStatus(t, port, { Origin: 'https://ignored.example' }), 403, 'the flag wins over VARANDA_WS_ORIGIN')
  t.is(await upgradeStatus(t, port, { Origin: 'http://127.0.0.1:8790' }), 403, 'the loopback default no longer applies')
  t.is(await upgradeStatus(t, port, {}), 'open', 'an Origin-less (non-browser) client is still accepted')
  // A TLS proxy forwards to 127.0.0.1:<port> and rewrites Host to it (Caddy's
  // header_up Host {upstream_hostport}); the public name itself is refused.
  t.is(await upgradeStatus(t, port, { Origin: 'https://app.example', Host: 'app.example' }), 421, 'the public Host is refused')

  proc.child.kill('SIGTERM')
  t.is(await proc.exited, 0)
})

test('--ws-origin and VARANDA_WS_ORIGIN are validated as usage errors', async (t) => {
  await testnet(t)
  const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 })
  const flag = run(['seed', '--ws-origin', 'https://app.example/'])
  t.is(flag.status, 2)
  t.ok(flag.stderr.includes('ws-origin inválido https://app.example/'))
  const variable = run(['seed'], { VARANDA_WS_ORIGIN: ' , ' })
  t.is(variable.status, 2)
  t.ok(variable.stderr.includes('ws-origin inválido (vazio)'))
})
