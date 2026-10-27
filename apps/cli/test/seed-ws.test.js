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
const { testnet, tmpDir, until, bootstrapFlags, localSwarmOptions } = require('./helpers/net')
const { Seeder, MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair, seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission, generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord } = require('@varanda/core/lib/records')
const {
  startSeedWs, MAX_PAYLOAD, MEDIA_MAX_BLOCKS, MEDIA_MAX_IN_FLIGHT, MEDIA_RATE, MEDIA_BURST,
  INDEX_POST_RE, INDEX_COUNTS_RE, INDEX_MEMBER_RE, INDEX_MAX_REFS, INDEX_MAX_IN_FLIGHT, INDEX_RATE, INDEX_BURST, INDEX_DEADLINE_MS, INDEX_MAX_BODY
} = require('../lib/seed-ws')

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

test('startSeedWs: a capacity refusal by the real Seeder closes the WebSocket with 1013 lotado', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: assoc.hex, maxExternal: 1, log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  // The first socket (an in-flight handshake) takes the only external slot.
  const first = await openSeederWs(t, server.port)
  await until(() => seeder.stats().connections === 1, { name: 'primeira conexão contada' })

  const second = await openSeederWs(t, server.port)
  const started = Date.now()
  const { code, reason } = await within(second.closed, 5000, 'close da segunda')
  t.is(code, 1013, 'the refused socket is closed with 1013 (try again later), not 1006')
  t.is(reason, 'lotado')
  t.ok(Date.now() - started < 3000, 'closed promptly')
  t.ok(events.some((e) => e.event === 'peer-dropped' && e.reason === 'connection-limit'), 'connection-limit logged')
  t.is(seeder.stats().connections, 1, 'the refused socket never took a slot')

  // On loopback a close frame queued just before terminate() still arrives,
  // so the code alone cannot prove the server did not tear the socket down at
  // once (createWebSocketStream terminates on destroy; behind a proxy that
  // turns into 1006). A raw client that never answers the close shows it: the
  // server must keep the socket for the grace, waiting for the client's
  // close, and only then terminate it.
  const raw = await mutedRefusal(t, server.port)
  t.ok(raw.bytes.includes(CLOSE_1013_LOTADO), 'the raw client received the 1013 lotado close frame')
  t.ok(raw.heldMs >= 500, 'the server waited for the close handshake (' + raw.heldMs + ' ms), it did not terminate at once')
  t.ok(raw.heldMs < 3000, 'and destroyed the socket after the grace')
  t.is(seeder.stats().connections, 1, 'still one connection')
  t.is(first.ws.readyState, WebSocket.OPEN, 'the admitted socket stays open')
})

// An unmasked server close frame: FIN + opcode 8, length 8, code 1013, 'lotado'.
const CLOSE_1013_LOTADO = Buffer.concat([Buffer.from([0x88, 0x08, 0x03, 0xf5]), Buffer.from('lotado')])

// A raw client that completes the /seeder upgrade and then stays silent (it
// never answers a close frame). Resolves { bytes, heldMs } once the server
// closes the connection, heldMs measured from the close frame's arrival.
function mutedRefusal (t, port) {
  return within(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    t.teardown(() => socket.destroy(), { force: true })
    let bytes = Buffer.alloc(0)
    let closeAt = null
    socket.on('error', () => {})
    socket.on('data', (d) => {
      bytes = Buffer.concat([bytes, d])
      if (closeAt === null && bytes.includes(CLOSE_1013_LOTADO)) closeAt = Date.now()
    })
    socket.once('close', () => resolve({ bytes, heldMs: closeAt === null ? -1 : Date.now() - closeAt }))
    socket.once('connect', () => {
      socket.write('GET /seeder HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    socket.once('error', reject)
  }), 5000, 'close do cliente mudo')
}

test('startSeedWs: a stub refusal through onRefuse closes with 1013; a plain null still terminates', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok')
  let mode = 'refuse'
  seeder.acceptStream = (duplex, opts) => {
    if (mode === 'refuse') {
      opts.onRefuse({ reason: 'connection-limit' })
      return null
    }
    duplex.destroy()
    return null
  }
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const refused = await openSeederWs(t, server.port)
  t.alike(await within(refused.closed, 5000, 'close recusado'), { code: 1013, reason: 'lotado' })

  mode = 'null'
  const dropped = await openSeederWs(t, server.port)
  t.is((await within(dropped.closed, 5000, 'close nulo')).code, 1006, 'without the handoff the socket is terminated as before')
})

test('startSeedWs: a refused socket whose client never answers the close is destroyed after the grace', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder('ok')
  seeder.acceptStream = (duplex, opts) => {
    opts.onRefuse({ reason: 'connection-limit' })
    return null
  }
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  // A raw client that completes the upgrade but never sends a close frame
  // back nor ends its side: only the server's grace timer can free it.
  const client = await halfOpenUpgrade(server.port, '/seeder')
  t.teardown(() => client.socket.destroy(), { force: true })
  const ms = await within(client.closed, 5000, 'close do cliente mudo')
  t.ok(client.response().startsWith('HTTP/1.1 101'), 'the upgrade completed')
  t.ok(ms < 3000, 'destroyed within the grace (' + ms + ' ms), not the 30 s close timeout of ws')
  t.ok(client.socket.destroyed)
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

// --- /media/<D>/<K>/<start>/<blocks> ---------------------------------------

const D = 'a'.repeat(64)
const K = 'b'.repeat(64)

// A stub seeder whose mediaRead serves `count` blocks of `size` bytes for
// D/K, counting the blocks the server pulled from the iterator and whether
// the iterator was closed. gate: optional promise awaited before each block.
function mediaSeeder ({ size = 4, gate = null } = {}) {
  const stub = stubSeeder('ok')
  stub.calls = []
  stub.pulled = 0
  stub.finished = false
  stub.mediaRead = (diary, core, start, count) => {
    stub.calls.push([diary, core, start, count])
    if (diary !== D || core !== K) return null
    async function * blocks () {
      try {
        for (let i = 0; i < count; i++) {
          if (gate) await gate
          stub.pulled++
          yield b4a.alloc(size, (start + i) % 256)
        }
      } finally {
        stub.finished = true
      }
    }
    return { bytes: size * count, blocks: blocks() }
  }
  return stub
}

// A plain HTTP request with its own connection; the body is a Buffer.
function mediaRequest (port, url, { method = 'GET', host = '127.0.0.1:' + port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b4a.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// Starts a request and resolves { req, res } once the headers arrived; the
// body is left unread (paused).
function openMedia (port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, agent: false }, (res) => {
      res.pause()
      resolve({ req, res })
    })
    req.on('error', () => {})
    req.once('error', reject)
    req.end()
  })
}

test('startSeedWs /media: limits are exported with their documented values', async (t) => {
  t.is(MEDIA_MAX_BLOCKS, 256)
  t.is(MEDIA_MAX_IN_FLIGHT, 16)
  t.is(MEDIA_RATE, 64)
  t.is(MEDIA_BURST, 128)
})

test('startSeedWs /media: GET streams the exact bytes with immutable headers, HEAD sends headers only', async (t) => {
  t.timeout(20000)
  const seeder = mediaSeeder({ size: 5 })
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const url = '/media/' + D + '/' + K + '/3/4'
  const got = await mediaRequest(server.port, url)
  t.is(got.status, 200)
  t.alike(seeder.calls[0], [D, K, 3, 4], 'mediaRead called with the parsed values')
  const expected = b4a.concat([3, 4, 5, 6].map((v) => b4a.alloc(5, v)))
  t.alike(got.body, expected, 'exact bytes in order')
  t.is(got.headers['content-type'], 'application/octet-stream')
  t.is(got.headers['content-length'], '20')
  t.is(got.headers['x-content-type-options'], 'nosniff')
  t.is(got.headers['cache-control'], 'public, max-age=31536000, immutable')
  t.is(got.headers['accept-ranges'], 'none')
  t.is(got.headers['access-control-allow-origin'], undefined, 'no CORS header')

  const pulledBefore = seeder.pulled
  const head = await mediaRequest(server.port, url, { method: 'HEAD' })
  t.is(head.status, 200)
  t.is(head.headers['content-length'], '20')
  t.is(head.headers['cache-control'], 'public, max-age=31536000, immutable')
  t.is(head.body.byteLength, 0, 'HEAD has no body')
  t.is(seeder.pulled, pulledBefore, 'HEAD pulls no block')

  const max = await mediaRequest(server.port, '/media/' + D + '/' + K + '/1/256')
  t.is(max.status, 200, '256 blocks accepted')
  t.is(max.body.byteLength, 5 * 256)
})

test('startSeedWs /media: malformed paths, a refused read and a missing mediaRead are the same 404', async (t) => {
  t.timeout(20000)
  const seeder = mediaSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const bad = [
    '/media',
    '/media/',
    '/media/' + D + '/' + K + '/1',
    '/media/' + D + '/' + K + '/1/1/',
    '/media/' + D + '/' + K + '/1/1/extra',
    '/media/' + 'g'.repeat(64) + '/' + K + '/1/1',
    '/media/' + D.slice(1) + '/' + K + '/1/1',
    '/media/' + D + 'a/' + K + '/1/1',
    '/media/' + 'A'.repeat(64) + '/' + K + '/1/1',
    '/media/' + D + '/' + 'B'.repeat(64) + '/1/1',
    '/media/' + D + '/' + K + '/0/1',
    '/media/' + D + '/' + K + '/1/0',
    '/media/' + D + '/' + K + '/1/257',
    '/media/' + D + '/' + K + '/1/999',
    '/media/' + D + '/' + K + '/01/1',
    '/media/' + D + '/' + K + '/1/01',
    '/media/' + D + '/' + K + '/-1/1',
    '/media/' + D + '/' + K + '/+1/1',
    '/media/' + D + '/' + K + '/1.0/1',
    '/media/' + D + '/' + K + '/1e3/1',
    '/media/' + D + '/' + K + '/' + '9'.repeat(16) + '/1',
    '/media/' + D + '/' + K + '/1/1?x=1',
    '/media/' + D + '/' + K + '/1/1?',
    '/media//' + D + '/' + K + '/1/1',
    '/media/' + D + '/' + K + '/%31/1'
  ]
  for (const url of bad) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, url.slice(0, 24) + '... -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
    t.is(got.headers['cache-control'], 'no-store')
  }
  t.is(seeder.calls.length, 0, 'malformed paths never reach mediaRead')

  const refused = await mediaRequest(server.port, '/media/' + 'c'.repeat(64) + '/' + K + '/1/1')
  t.is(refused.status, 404, 'mediaRead null -> 404')
  t.is(refused.body.toString(), 'não encontrado\n')
  t.is(seeder.calls.length, 1)

  const throwing = mediaSeeder()
  throwing.mediaRead = () => { throw new Error('secret ' + D) }
  const s2 = await startSeedWs({ port: 0, seeder: throwing })
  t.teardown(() => s2.close(), { force: true })
  const thrown = await mediaRequest(s2.port, '/media/' + D + '/' + K + '/1/1')
  t.is(thrown.status, 404, 'a throwing mediaRead -> 404')
  t.absent(thrown.body.toString().includes('secret'))

  const old = await startSeedWs({ port: 0, seeder: stubSeeder('ok') })
  t.teardown(() => old.close(), { force: true })
  const missing = await mediaRequest(old.port, '/media/' + D + '/' + K + '/1/1')
  t.is(missing.status, 404, 'a seeder without mediaRead -> 404')

  const other = await mediaRequest(server.port, '/some/path?x=1')
  t.is(other.status, 404, 'other paths still 404')
})

test('startSeedWs /media: Host is checked first (421), other methods are 405 with Allow', async (t) => {
  t.timeout(20000)
  const seeder = mediaSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const url = '/media/' + D + '/' + K + '/1/1'

  const evil = await mediaRequest(server.port, url, { host: 'evil.example:' + server.port })
  t.is(evil.status, 421, 'foreign Host -> 421')
  const evilPost = await mediaRequest(server.port, url, { method: 'POST', host: 'evil.example:' + server.port })
  t.is(evilPost.status, 421, 'the Host check runs before the method check')

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const got = await mediaRequest(server.port, url, { method })
    t.is(got.status, 405, method + ' -> 405')
    t.is(got.headers.allow, 'GET, HEAD')
  }
  const badPathPost = await mediaRequest(server.port, '/media/x', { method: 'POST' })
  t.is(badPathPost.status, 405, 'any other method on /media -> 405')
  t.is(seeder.calls.length, 0, 'refused requests never reach mediaRead')
})

test('startSeedWs /media: a slow reader applies backpressure (the server does not buffer ahead)', async (t) => {
  t.timeout(30000)
  const size = 1024 * 1024
  const seeder = mediaSeeder({ size })
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const { req, res } = await openMedia(server.port, '/media/' + D + '/' + K + '/1/64')
  t.teardown(() => req.destroy(), { force: true })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const pulledWhilePaused = seeder.pulled
  t.ok(pulledWhilePaused < 16, 'only a few blocks pulled while the client reads nothing (' + pulledWhilePaused + ' of 64)')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(seeder.pulled, pulledWhilePaused, 'no further block pulled while paused')

  let received = 0
  res.on('data', (d) => { received += d.byteLength })
  const ended = new Promise((resolve) => res.once('end', resolve))
  res.resume()
  await within(ended, 20000, 'fim do corpo')
  t.is(received, 64 * size, 'the whole body arrives once the client reads')
  t.is(seeder.pulled, 64)
})

test('startSeedWs /media: a client that goes away stops the iteration', async (t) => {
  t.timeout(30000)
  const size = 1024 * 1024
  const seeder = mediaSeeder({ size })
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const { req, res } = await openMedia(server.port, '/media/' + D + '/' + K + '/1/256')
  res.on('error', () => {})
  await new Promise((resolve) => res.once('readable', resolve))
  req.destroy()
  await until(() => seeder.finished, { name: 'iterador fechado', timeoutMs: 5000 })
  t.ok(seeder.finished, 'the iterator was closed')
  t.ok(seeder.pulled < 256, 'not every block was pulled (' + seeder.pulled + ')')
})

test('startSeedWs /media: the in-flight cap answers 503 ocupado with Retry-After', async (t) => {
  t.timeout(30000)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const seeder = mediaSeeder({ gate })
  const server = await startSeedWs({ port: 0, seeder, media: { maxInFlight: 2 } })
  t.teardown(() => server.close(), { force: true })
  const url = '/media/' + D + '/' + K + '/1/2'

  const held = [await openMedia(server.port, url), await openMedia(server.port, url)]
  for (const h of held) t.teardown(() => h.req.destroy(), { force: true })
  const busy = await mediaRequest(server.port, url)
  t.is(busy.status, 503, 'third concurrent response refused')
  t.is(busy.body.toString(), 'ocupado\n')
  t.is(busy.headers['retry-after'], '1')
  t.is(busy.headers['cache-control'], 'no-store')

  const done = held.map(({ res }) => new Promise((resolve) => { res.on('end', resolve); res.resume() }))
  release()
  await within(Promise.all(done), 5000, 'fim das respostas retidas')
  await until(async () => (await mediaRequest(server.port, url)).status === 200, { name: 'slots liberados', timeoutMs: 5000 })
  t.pass('slots are released once the responses close')

  // An aborted response releases its slot too (once its pending read settles).
  let release2
  const gate2 = new Promise((resolve) => { release2 = resolve })
  const s2 = await startSeedWs({ port: 0, seeder: mediaSeeder({ gate: gate2 }), media: { maxInFlight: 1 } })
  t.teardown(() => s2.close(), { force: true })
  const one = await openMedia(s2.port, url)
  one.res.on('error', () => {})
  t.is((await mediaRequest(s2.port, url)).status, 503)
  one.req.destroy()
  release2()
  await until(async () => (await mediaRequest(s2.port, url, { method: 'HEAD' })).status === 200, { name: 'slot liberado', timeoutMs: 5000 })
  t.pass('an aborted response frees its slot')
})

// A seeder whose first mediaRead returns a hand-written iterator whose
// next() stalls until stub.unstall() (so return() is observable while a
// next() is pending, unlike an async generator); later reads are normal.
function stallingSeeder () {
  const stub = mediaSeeder()
  const normal = stub.mediaRead
  stub.returned = false
  let first = true
  let unstall
  const stalled = new Promise((resolve) => { unstall = resolve })
  stub.unstall = () => unstall({ done: false, value: b4a.alloc(4, 1) })
  stub.mediaRead = (diary, core, start, count) => {
    if (!first) return normal(diary, core, start, count)
    first = false
    const it = {
      next: () => stalled,
      return: () => {
        stub.returned = true
        return Promise.resolve({ done: true })
      },
      [Symbol.asyncIterator] () { return it }
    }
    return { bytes: 4 * count, blocks: it }
  }
  return stub
}

async function stalledSlotHeld (t, seeder, server, url) {
  await until(() => seeder.returned, { name: 'return() chamado', timeoutMs: 5000 })
  t.ok(seeder.returned, "the iterator's return() is called while next() is still pending")
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is((await mediaRequest(server.port, url)).status, 503, 'the stalled read still holds its slot')
  seeder.unstall()
  await until(async () => (await mediaRequest(server.port, url)).status === 200, { name: 'slot liberado', timeoutMs: 5000 })
  t.pass('the slot is freed once the stalled next() settles')
}

test('startSeedWs /media: a client abort during a stalled read closes the iterator; the slot waits for the read', async (t) => {
  t.timeout(20000)
  const seeder = stallingSeeder()
  const server = await startSeedWs({ port: 0, seeder, media: { maxInFlight: 1 } })
  t.teardown(() => server.close(), { force: true })
  const url = '/media/' + D + '/' + K + '/1/1'
  const { req, res } = await openMedia(server.port, url)
  res.on('error', () => {})
  req.destroy()
  await stalledSlotHeld(t, seeder, server, url)
})

test('startSeedWs /media: the deadline during a stalled read closes the iterator; the slot waits for the read', async (t) => {
  t.timeout(20000)
  const seeder = stallingSeeder()
  const server = await startSeedWs({ port: 0, seeder, media: { maxInFlight: 1, deadlineMs: 200 } })
  t.teardown(() => server.close(), { force: true })
  const url = '/media/' + D + '/' + K + '/1/1'
  const { req, res } = await openMedia(server.port, url)
  t.teardown(() => req.destroy(), { force: true })
  res.on('error', () => {})
  res.resume()
  await within(new Promise((resolve) => res.once('close', resolve)), 5000, 'close após o prazo')
  await stalledSlotHeld(t, seeder, server, url)
})

test('startSeedWs /media: the global token bucket answers 503 beyond the burst', async (t) => {
  t.timeout(20000)
  const seeder = mediaSeeder()
  const server = await startSeedWs({ port: 0, seeder, media: { rate: 0.001, burst: 3 } })
  t.teardown(() => server.close(), { force: true })
  const url = '/media/' + D + '/' + K + '/1/1'
  for (let i = 0; i < 3; i++) t.is((await mediaRequest(server.port, url)).status, 200, 'within the burst')
  const over = await mediaRequest(server.port, url)
  t.is(over.status, 503, 'beyond the burst')
  t.is(over.headers['retry-after'], '1')
  t.is(seeder.calls.length, 3, 'a refused request never reaches mediaRead')
})

test('startSeedWs /media: a response past the deadline is destroyed', async (t) => {
  t.timeout(20000)
  const seeder = mediaSeeder({ gate: new Promise(() => {}) })
  const server = await startSeedWs({ port: 0, seeder, media: { deadlineMs: 200 } })
  t.teardown(() => server.close(), { force: true })
  const { req, res } = await openMedia(server.port, '/media/' + D + '/' + K + '/1/1')
  t.teardown(() => req.destroy(), { force: true })
  res.on('error', () => {})
  res.resume()
  await within(new Promise((resolve) => res.once('close', resolve)), 5000, 'close após o prazo')
  t.absent(res.complete, 'the body was cut short, not completed')
})

// --- /index/post, /index/counts, /index/member ------------------------------

const A = 'c'.repeat(64)
const B = 'd'.repeat(64)
const CURSOR = '1700000000000.' + B + '.7'

function pageOf (ref) {
  return {
    ref,
    parent: null,
    replies: [B + ':7'],
    next: null,
    quotes: [],
    likes: 1,
    reposts: 0,
    repliesTotal: 1,
    quotesTotal: 0,
    authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 3 } },
    indexing: false,
    complete: true
  }
}

// A stub seeder with the three index methods, recording every call. gate:
// optional promise awaited inside each call (holds the in-flight slot).
function indexSeeder ({ gate = null } = {}) {
  const stub = stubSeeder('ok')
  stub.calls = []
  const wait = async () => { if (gate) await gate }
  stub.indexPost = async (author, seq, cursor) => {
    stub.calls.push(['indexPost', author, seq, cursor])
    await wait()
    return author === A ? pageOf(author + ':' + seq) : null
  }
  stub.indexCounts = async (refs) => {
    stub.calls.push(['indexCounts', refs])
    await wait()
    const counts = {}
    for (const ref of refs) if (ref.startsWith(A)) counts[ref] = { replies: 1, likes: 2, reposts: 3, quotes: 4 }
    return { counts, indexing: true, complete: false }
  }
  stub.indexMember = async (author, before) => {
    stub.calls.push(['indexMember', author, before])
    await wait()
    return author === A ? { length: 9, profileSeq: 1, usernameSeq: null, posts: [8, 5, 2], postsTotal: 3, indexing: false, complete: true } : null
  }
  return stub
}

function jsonHeaders (t, got) {
  t.is(got.headers['content-type'], 'application/json; charset=utf-8')
  t.is(got.headers['cache-control'], 'no-store')
  t.is(got.headers['x-content-type-options'], 'nosniff')
  t.is(got.headers['access-control-allow-origin'], undefined, 'no CORS header')
}

test('startSeedWs /index: limits and regexes are exported with their documented values', async (t) => {
  t.is(INDEX_MAX_REFS, 31)
  t.is(INDEX_MAX_IN_FLIGHT, 16)
  t.is(INDEX_RATE, 32)
  t.is(INDEX_BURST, 64)
  t.is(INDEX_DEADLINE_MS, 30000)
  t.is(INDEX_MAX_BODY, 65536)
  t.is(INDEX_POST_RE.source, '^\\/index\\/post\\/([0-9a-f]{64})\\/([1-9][0-9]{0,14})(?:\\/([0-9]{1,16}\\.[0-9a-f]{64}\\.[1-9][0-9]{0,14}))?$')
  t.is(INDEX_MEMBER_RE.source, '^\\/index\\/member\\/([0-9a-f]{64})(?:\\/([1-9][0-9]{0,14}))?$')
  t.ok(INDEX_COUNTS_RE.test('/index/counts/' + A + ':1'), 'one ref')
  t.ok(INDEX_COUNTS_RE.test('/index/counts/' + Array.from({ length: 31 }, (_, i) => A + ':' + (i + 1)).join(',')), '31 refs')
  t.absent(INDEX_COUNTS_RE.test('/index/counts/' + Array.from({ length: 32 }, (_, i) => A + ':' + (i + 1)).join(',')), '32 refs')
})

test('startSeedWs /index: GET answers JSON with the parsed arguments, HEAD sends the headers only', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const post = await mediaRequest(server.port, '/index/post/' + A + '/12')
  t.is(post.status, 200)
  jsonHeaders(t, post)
  t.is(post.headers['content-length'], String(post.body.byteLength))
  t.alike(JSON.parse(post.body.toString()), pageOf(A + ':12'))
  t.alike(seeder.calls[0], ['indexPost', A, 12, null], 'no cursor -> null')

  const paged = await mediaRequest(server.port, '/index/post/' + A + '/12/' + CURSOR)
  t.is(paged.status, 200)
  t.alike(seeder.calls[1], ['indexPost', A, 12, CURSOR], 'the cursor is passed as a string')

  const maxSeq = await mediaRequest(server.port, '/index/post/' + A + '/' + '9'.repeat(15))
  t.is(maxSeq.status, 200)
  t.is(seeder.calls[2][2], 999999999999999, '15 digits stay an exact safe integer')

  const counts = await mediaRequest(server.port, '/index/counts/' + A + ':1,' + B + ':2,' + A + ':3')
  t.is(counts.status, 200)
  jsonHeaders(t, counts)
  t.alike(JSON.parse(counts.body.toString()), { counts: { [A + ':1']: { replies: 1, likes: 2, reposts: 3, quotes: 4 }, [A + ':3']: { replies: 1, likes: 2, reposts: 3, quotes: 4 } }, indexing: true, complete: false })
  t.alike(seeder.calls[3], ['indexCounts', [A + ':1', B + ':2', A + ':3']], 'refs split in order')

  const member = await mediaRequest(server.port, '/index/member/' + A)
  t.is(member.status, 200)
  jsonHeaders(t, member)
  t.alike(JSON.parse(member.body.toString()), { length: 9, profileSeq: 1, usernameSeq: null, posts: [8, 5, 2], postsTotal: 3, indexing: false, complete: true })
  t.alike(seeder.calls[4], ['indexMember', A, null], 'no before -> null')
  const before = await mediaRequest(server.port, '/index/member/' + A + '/5')
  t.is(before.status, 200)
  t.alike(seeder.calls[5], ['indexMember', A, 5])

  const head = await mediaRequest(server.port, '/index/post/' + A + '/12', { method: 'HEAD' })
  t.is(head.status, 200)
  jsonHeaders(t, head)
  t.is(head.headers['content-length'], post.headers['content-length'], 'HEAD announces the GET length')
  t.is(head.body.byteLength, 0, 'HEAD has no body')
  t.is(seeder.calls.length, 7, 'HEAD still asks the seeder (it needs the length)')
})

test('startSeedWs /index: malformed paths never reach the seeder and are the same 404', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const refs32 = Array.from({ length: 32 }, (_, i) => A + ':' + (i + 1)).join(',')
  const bad = [
    '/index',
    '/index/',
    '/index/post',
    '/index/post/' + A,
    '/index/post/' + A + '/',
    '/index/post/' + A + '/1/',
    '/index/post/' + A.toUpperCase() + '/1',
    '/index/post/' + A.slice(1) + '/1',
    '/index/post/' + A + 'c/1',
    '/index/post/' + A + '/0',
    '/index/post/' + A + '/01',
    '/index/post/' + A + '/-1',
    '/index/post/' + A + '/1.0',
    '/index/post/' + A + '/' + '9'.repeat(16),
    '/index/post/' + A + '/1?x=1',
    '/index/post/' + A + '/1?',
    '/index/post/' + A + '/%31',
    '/index/post/' + A + '/1/' + CURSOR + '/',
    '/index/post/' + A + '/1/' + CURSOR + '/x',
    '/index/post/' + A + '/1/' + '1700000000000.' + B,
    '/index/post/' + A + '/1/' + '1700000000000.' + B.toUpperCase() + '.7',
    '/index/post/' + A + '/1/' + '1700000000000.' + B + '.0',
    '/index/post/' + A + '/1/' + '1700000000000.' + B + '.07',
    '/index/post/' + A + '/1/' + '1'.repeat(17) + '.' + B + '.7',
    '/index/post/' + A + '/1/' + '.' + B + '.7',
    '/index/post/' + A + '/1/' + '-1.' + B + '.7',
    '/index/post/' + A + '/1/' + '1700000000000:' + B + ':7',
    '/index/counts',
    '/index/counts/',
    '/index/counts/' + A,
    '/index/counts/' + A + ':0',
    '/index/counts/' + A + ':01',
    '/index/counts/' + A + ':1,',
    '/index/counts/,' + A + ':1',
    '/index/counts/' + A + ':1,,' + B + ':2',
    '/index/counts/' + A + ':1,%20' + B + ':2',
    '/index/counts/' + A + ':1;' + B + ':2',
    '/index/counts/' + A.toUpperCase() + ':1',
    '/index/counts/' + A + ':' + '9'.repeat(16),
    '/index/counts/' + refs32,
    '/index/counts/' + A + ':1?x=1',
    '/index/member',
    '/index/member/',
    '/index/member/' + A + '/',
    '/index/member/' + A + '/0',
    '/index/member/' + A + '/01',
    '/index/member/' + A + '/' + '9'.repeat(16),
    '/index/member/' + A.toUpperCase(),
    '/index/member/' + A + '/1/2',
    '/index/member/' + A + '?x=1',
    '/index/other/' + A,
    '/index//post/' + A + '/1',
    '/INDEX/post/' + A + '/1',
    '/indexes/post/' + A + '/1'
  ]
  for (const url of bad) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, url.slice(0, 40) + '... -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
    t.is(got.headers['cache-control'], 'no-store')
    t.is(got.headers['x-content-type-options'], 'nosniff')
  }
  t.is(seeder.calls.length, 0, 'malformed paths never reach the seeder')
  const refs31 = Array.from({ length: 31 }, (_, i) => A + ':' + (i + 1)).join(',')
  t.is((await mediaRequest(server.port, '/index/counts/' + refs31)).status, 200, '31 refs accepted')
  t.is(seeder.calls.length, 1)
})

test('startSeedWs /index: a null answer, a throw, a rejection, a non-object and a seeder without the methods are 404, nothing echoed', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  for (const url of ['/index/post/' + B + '/1', '/index/member/' + B]) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, 'null answer -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
    t.is(got.headers['content-type'], 'text/plain; charset=utf-8')
  }
  t.is(seeder.calls.length, 2, 'the seeder was asked')

  const throwing = indexSeeder()
  throwing.indexPost = () => { throw new Error('secret ' + A) }
  throwing.indexCounts = () => Promise.reject(new Error('secret ' + A))
  throwing.indexMember = () => [1, 2, 3]
  const s2 = await startSeedWs({ port: 0, seeder: throwing })
  t.teardown(() => s2.close(), { force: true })
  for (const url of ['/index/post/' + A + '/1', '/index/counts/' + A + ':1', '/index/member/' + A]) {
    const got = await mediaRequest(s2.port, url)
    t.is(got.status, 404, url.slice(0, 20) + ' -> 404')
    t.absent(got.body.toString().includes('secret'), 'nothing of the error is echoed')
    t.absent(got.body.toString().includes(A.slice(0, 8)), 'no key is echoed')
  }

  const old = await startSeedWs({ port: 0, seeder: stubSeeder('ok') })
  t.teardown(() => old.close(), { force: true })
  for (const url of ['/index/post/' + A + '/1', '/index/counts/' + A + ':1', '/index/member/' + A]) {
    t.is((await mediaRequest(old.port, url)).status, 404, 'a seeder without the index methods -> 404')
  }
})

test('startSeedWs /index: Host is checked first (421), other methods are 405 with Allow', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const url = '/index/post/' + A + '/1'

  const evil = await mediaRequest(server.port, url, { host: 'evil.example:' + server.port })
  t.is(evil.status, 421, 'foreign Host -> 421')
  const evilPost = await mediaRequest(server.port, url, { method: 'POST', host: 'evil.example:' + server.port })
  t.is(evilPost.status, 421, 'the Host check runs before the method check')

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const got = await mediaRequest(server.port, url, { method })
    t.is(got.status, 405, method + ' -> 405')
    t.is(got.headers.allow, 'GET, HEAD')
    t.is(got.headers['cache-control'], 'no-store')
  }
  t.is((await mediaRequest(server.port, '/index/x', { method: 'POST' })).status, 405, 'any other method under /index -> 405')
  t.is((await mediaRequest(server.port, '/index', { method: 'POST' })).status, 405, 'POST /index -> 405')
  t.is(seeder.calls.length, 0, 'refused requests never reach the seeder')
})

test('startSeedWs /index: its own in-flight cap and token bucket answer 503 ocupado with Retry-After', async (t) => {
  t.timeout(30000)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const seeder = indexSeeder({ gate })
  const server = await startSeedWs({ port: 0, seeder, index: { maxInFlight: 2 }, media: { maxInFlight: 1 } })
  t.teardown(() => server.close(), { force: true })
  const url = '/index/counts/' + A + ':1'

  const held = [mediaRequest(server.port, url), mediaRequest(server.port, '/index/member/' + A)]
  await until(() => seeder.calls.length === 2, { name: 'duas chamadas retidas', timeoutMs: 5000 })
  const busy = await mediaRequest(server.port, url)
  t.is(busy.status, 503, 'third concurrent answer refused')
  t.is(busy.body.toString(), 'ocupado\n')
  t.is(busy.headers['retry-after'], '1')
  t.is(busy.headers['cache-control'], 'no-store')
  t.is(seeder.calls.length, 2, 'a refused request never reaches the seeder')
  // The caps are separate from /media's: a media read still has its slot.
  seeder.mediaRead = mediaSeeder().mediaRead
  t.is((await mediaRequest(server.port, '/media/' + D + '/' + K + '/1/1')).status, 200, '/media is not held by /index')
  release()
  const done = await Promise.all(held)
  t.alike(done.map((r) => r.status), [200, 200])
  await until(async () => (await mediaRequest(server.port, url)).status === 200, { name: 'slots liberados', timeoutMs: 5000 })
  t.pass('slots are released once the answers settle')

  const s2 = await startSeedWs({ port: 0, seeder: indexSeeder(), index: { rate: 0.001, burst: 3 } })
  t.teardown(() => s2.close(), { force: true })
  for (let i = 0; i < 3; i++) t.is((await mediaRequest(s2.port, url)).status, 200, 'within the burst')
  const over = await mediaRequest(s2.port, url)
  t.is(over.status, 503, 'beyond the burst')
  t.is(over.headers['retry-after'], '1')
  t.is((await mediaRequest(s2.port, url, { method: 'HEAD' })).status, 503, 'HEAD spends a token too')
})

test('startSeedWs /index: duplicate refs collapse before the seeder is asked', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const refs = Array.from({ length: 31 }, () => A + ':1')
  refs[1] = B + ':2'
  const got = await mediaRequest(server.port, '/index/counts/' + refs.join(','))
  t.is(got.status, 200)
  t.alike(seeder.calls[0], ['indexCounts', [A + ':1', B + ':2']], '31 refs with duplicates -> two distinct refs, first occurrence order')
  t.alike(Object.keys(JSON.parse(got.body.toString()).counts), [A + ':1'])
})

test('startSeedWs /index: the slot is held until the response closes and the call settles; a stalled answer hits the deadline', async (t) => {
  t.timeout(20000)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const seeder = indexSeeder({ gate })
  const server = await startSeedWs({ port: 0, seeder, index: { maxInFlight: 1, deadlineMs: 200 } })
  t.teardown(() => server.close(), { force: true })
  const url = '/index/member/' + A

  // A raw client: a stalled call sends no headers, so at the deadline the
  // client only sees its connection closed.
  const stalled = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: server.port })
    socket.on('error', () => {})
    const closed = new Promise((resolve) => socket.once('close', resolve))
    socket.once('connect', () => {
      socket.write('GET ' + url + ' HTTP/1.1\r\nHost: 127.0.0.1:' + server.port + '\r\n\r\n')
      resolve({ socket, closed })
    })
    socket.once('error', reject)
  })
  t.teardown(() => stalled.socket.destroy(), { force: true })
  await until(() => seeder.calls.length === 1, { name: 'chamada retida', timeoutMs: 5000 })
  t.is((await mediaRequest(server.port, url)).status, 503, 'the stalled call holds the only slot')
  await within(stalled.closed, 5000, 'close no prazo')
  t.pass('the stalled response is destroyed at the deadline')
  t.is((await mediaRequest(server.port, url)).status, 503, 'past the deadline the response is gone but the call still holds the slot')
  t.is(seeder.calls.length, 1, 'refused requests never reach the seeder')
  release()
  await until(async () => (await mediaRequest(server.port, url)).status === 200, { name: 'slot liberado', timeoutMs: 5000 })
  t.pass('the slot is freed once the call settles and the response is closed')

  // A client that never reads: the small answer still completes (it fits
  // the socket buffers), so the slot is released on the response close.
  const slow = await openMedia(server.port, url)
  t.teardown(() => slow.req.destroy(), { force: true })
  t.is(slow.res.statusCode, 200)
  await until(async () => (await mediaRequest(server.port, url)).status === 200, { name: 'slot após resposta completa', timeoutMs: 5000 })
  t.pass('a completed answer frees its slot even while the client has not read it')
})

// The largest answer the contract allows: a full reply page and a full quote
// page from 100 distinct authors, a target and a parent from two more, every
// seq at 15 digits, a 16-digit cursor and the largest counts. It must fit in
// INDEX_MAX_BODY, and an answer that does not (never built by the index) is
// refused rather than sent.
test('startSeedWs /index: the worst-case answer stays within 64 KiB; an oversize answer is 404', async (t) => {
  t.timeout(20000)
  const hex = (i) => i.toString(16).padStart(64, '0')
  const seq = '9'.repeat(15)
  const authors = {}
  const replies = []
  const quotes = []
  for (let i = 0; i < 50; i++) {
    replies.push(hex(i) + ':' + seq)
    quotes.push(hex(100 + i) + ':' + seq)
    authors[hex(i)] = { profileSeq: Number(seq), usernameSeq: Number(seq) }
    authors[hex(100 + i)] = { profileSeq: Number(seq), usernameSeq: Number(seq) }
  }
  authors[hex(200)] = { profileSeq: Number(seq), usernameSeq: Number(seq) }
  authors[hex(201)] = { profileSeq: Number(seq), usernameSeq: Number(seq) }
  const worst = {
    ref: hex(200) + ':' + seq,
    parent: hex(201) + ':' + seq,
    replies,
    next: '9'.repeat(16) + '.' + hex(49) + '.' + seq,
    quotes,
    likes: Number.MAX_SAFE_INTEGER,
    reposts: Number.MAX_SAFE_INTEGER,
    repliesTotal: Number.MAX_SAFE_INTEGER,
    quotesTotal: Number.MAX_SAFE_INTEGER,
    authors,
    indexing: false,
    complete: false
  }
  t.is(Object.keys(authors).length, 102, '102 author hints')
  const seeder = indexSeeder()
  seeder.indexPost = async () => worst
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const got = await mediaRequest(server.port, '/index/post/' + A + '/1')
  t.is(got.status, 200)
  t.ok(got.body.byteLength <= INDEX_MAX_BODY, 'worst case is ' + got.body.byteLength + ' bytes <= ' + INDEX_MAX_BODY)
  t.ok(got.body.byteLength > 16384, 'the worst case is a real page (' + got.body.byteLength + ' bytes)')
  t.alike(JSON.parse(got.body.toString()), worst)

  const posts = Array.from({ length: 100 }, (_, i) => Number(seq) - i)
  seeder.indexMember = async () => ({ length: Number(seq), profileSeq: Number(seq), usernameSeq: Number(seq), posts, postsTotal: Number.MAX_SAFE_INTEGER, indexing: true, complete: false })
  const member = await mediaRequest(server.port, '/index/member/' + A)
  t.is(member.status, 200)
  t.ok(member.body.byteLength <= INDEX_MAX_BODY, 'member worst case is ' + member.body.byteLength + ' bytes')

  const counts = {}
  for (let i = 0; i < 31; i++) counts[hex(i) + ':' + seq] = { replies: Number.MAX_SAFE_INTEGER, likes: Number.MAX_SAFE_INTEGER, reposts: Number.MAX_SAFE_INTEGER, quotes: Number.MAX_SAFE_INTEGER }
  seeder.indexCounts = async () => ({ counts, indexing: true, complete: false })
  const c = await mediaRequest(server.port, '/index/counts/' + A + ':1')
  t.is(c.status, 200)
  t.ok(c.body.byteLength <= INDEX_MAX_BODY, 'counts worst case is ' + c.body.byteLength + ' bytes')

  seeder.indexPost = async () => ({ ...worst, replies: Array.from({ length: 1000 }, (_, i) => hex(i) + ':' + seq) })
  const over = await mediaRequest(server.port, '/index/post/' + A + '/1')
  t.is(over.status, 404, 'an answer over INDEX_MAX_BODY is never sent')
  t.is(over.body.toString(), 'não encontrado\n')
})
