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
const { memberCertRecord, postRecord, MAX_GROUPS_PER_DIARY, MAX_GROUP_NAME } = require('@varanda/core/lib/records')
const { groupHeader: makeGroupHeader } = require('@varanda/core/lib/group')
const {
  startSeedWs, socketCap, MAX_SOCKETS, MAX_PAYLOAD, MEDIA_MAX_BLOCKS, MEDIA_MAX_IN_FLIGHT, MEDIA_RATE, MEDIA_BURST,
  INDEX_POST_RE, INDEX_COUNTS_RE, INDEX_MEMBER_RE, INDEX_SEARCH_RE, INDEX_TOPIC_RE, INDEX_GROUP_RE, INDEX_GROUPS_RE, INDEX_GROUP_SEARCH_RE, INDEX_MAX_REFS, INDEX_MAX_IN_FLIGHT, INDEX_RATE, INDEX_BURST, INDEX_DEADLINE_MS, INDEX_MAX_BODY, GROUP_POST_RE
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

test('socketCap: the listener cap follows the external, /media and /index caps', async (t) => {
  // What startSeedWs computes for a seeder without maxExternal (the stub) and
  // the default /media and /index limits: today's 128.
  const stub = stubSeeder('ok')
  t.is(stub.maxExternal, undefined, 'the stub has no maxExternal')
  const defaults = { mediaInFlight: MEDIA_MAX_IN_FLIGHT, indexInFlight: INDEX_MAX_IN_FLIGHT }
  t.is(socketCap({ maxExternal: 32, ...defaults }), 128)
  t.is(socketCap({ maxExternal: 32, ...defaults }), MAX_SOCKETS)
  t.is(socketCap({ maxExternal: 32, ...defaults, sockets: 512 }), 512, 'VARANDA_MAX_SOCKETS wins')
  t.is(socketCap({ maxExternal: 512, ...defaults }), 608, 'a seeder with maxExternal 512')
  t.is(socketCap({ maxExternal: 32, ...defaults, sockets: null }), 128)
  t.is(socketCap({ maxExternal: 32, ...defaults, sockets: 0 }), 128, 'sockets below 1 is ignored')
  t.is(socketCap({ maxExternal: 1, ...defaults }), MAX_SOCKETS, 'never below MAX_SOCKETS')
})

test('startSeedWs: sockets caps the connections of the listener', async (t) => {
  t.timeout(20000)
  const ws = await startSeedWs({ port: 0, seeder: stubSeeder('ok'), sockets: 1 })
  t.teardown(() => ws.close(), { force: true })
  const first = net.connect({ host: '127.0.0.1', port: ws.port })
  first.on('error', () => {})
  t.teardown(() => first.destroy(), { force: true })
  await new Promise((resolve) => first.once('connect', resolve))
  // Let the server accept the first socket before the second arrives.
  await new Promise((resolve) => setTimeout(resolve, 100))
  const second = net.connect({ host: '127.0.0.1', port: ws.port })
  second.on('error', () => {})
  t.teardown(() => second.destroy(), { force: true })
  await within(new Promise((resolve) => second.once('close', resolve)), 2000, 'close da segunda conexão')
  t.pass('the connection beyond the cap is dropped')
  t.ok(!first.destroyed, 'the first connection stays open')
})

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

// A stub seeder with the four index methods, recording every call. gate:
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
  // A one-character segment is too short (null); 'ana' hits A, anything else
  // is a valid query with no hit.
  stub.indexSearch = async (segment) => {
    stub.calls.push(['indexSearch', segment])
    await wait()
    if (segment.length < 2) return null
    const members = segment === 'ana' ? [{ author: A, profileSeq: 1, usernameSeq: null }] : []
    return { members, more: false, indexing: false, complete: true }
  }
  stub.indexTopic = async (path, cursor) => {
    stub.calls.push(['indexTopic', path, cursor])
    await wait()
    return path === 'ceu+azul' || path === 'ceu'
      ? { items: [A + ':1'], next: null, authors: { [A]: { profileSeq: 1, usernameSeq: null } }, indexing: false, complete: true }
      : { items: [], next: null, authors: {}, indexing: false, complete: true }
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
  t.is(INDEX_SEARCH_RE.source, '^\\/index\\/search\\/([a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3})$')
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

// /index/search/<segment>: the folded search text, 1..4 tokens of
// [a-z0-9]{1,20} joined by single '-'; anything else never reaches the seeder.
test('startSeedWs /index/search: the canonical segment reaches indexSearch; GET answers JSON, HEAD the headers only', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const hit = await mediaRequest(server.port, '/index/search/ana')
  t.is(hit.status, 200)
  jsonHeaders(t, hit)
  t.is(hit.headers['content-length'], String(hit.body.byteLength))
  t.alike(JSON.parse(hit.body.toString()), { members: [{ author: A, profileSeq: 1, usernameSeq: null }], more: false, indexing: false, complete: true })
  t.alike(seeder.calls[0], ['indexSearch', 'ana'])

  const empty = await mediaRequest(server.port, '/index/search/ana-silva')
  t.is(empty.status, 200, 'a valid query with no hit is 200')
  jsonHeaders(t, empty)
  const parsed = JSON.parse(empty.body.toString())
  t.alike(Object.keys(parsed), ['members', 'more', 'indexing', 'complete'], 'exactly the contract keys')
  t.alike(parsed, { members: [], more: false, indexing: false, complete: true })
  t.alike(seeder.calls[1], ['indexSearch', 'ana-silva'])

  t.is((await mediaRequest(server.port, '/index/search/a-b')).status, 200)
  t.alike(seeder.calls[2], ['indexSearch', 'a-b'])

  const short = await mediaRequest(server.port, '/index/search/a')
  t.alike(seeder.calls[3], ['indexSearch', 'a'], 'a one-character segment reaches the seeder')
  t.is(short.status, 404, 'a null answer -> 404')
  t.is(short.body.toString(), 'não encontrado\n')

  const max = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20)].join('-')
  t.is((await mediaRequest(server.port, '/index/search/' + max)).status, 200, 'four 20-char tokens')
  t.alike(seeder.calls[4], ['indexSearch', max])

  const head = await mediaRequest(server.port, '/index/search/ana-silva', { method: 'HEAD' })
  t.is(head.status, 200)
  jsonHeaders(t, head)
  t.is(head.headers['content-length'], empty.headers['content-length'], 'HEAD announces the GET length')
  t.is(head.body.byteLength, 0, 'HEAD has no body')
  t.alike(seeder.calls[5], ['indexSearch', 'ana-silva'])
  t.is(seeder.calls.length, 6)
})

test('startSeedWs /index/search: malformed segments never reach the seeder and are the same 404, nothing echoed', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const bad = [
    '/index/search',
    '/index/search/',
    '/index/search/' + 'a'.repeat(21),
    '/index/search/ana-' + 'b'.repeat(21),
    '/index/search/a-b-c-d-e',
    '/index/search/-ana',
    '/index/search/ana-',
    '/index/search/ana--b',
    '/index/search/Ana',
    '/index/search/@ana',
    '/index/search/%40ana',
    '/index/search/ana_silva',
    '/index/search/ana.silva',
    '/index/search/%61na',
    '/index/search/ana%20silva',
    '/index/search/ana%2Dsilva',
    '/index/search/jos%C3%A9',
    '/index/search/ana/',
    '/index/search/ana?x=1',
    '/index/search/ana?',
    '/index/search/ana/silva',
    '/index/search/ana#x',
    '/index//search/ana',
    '/INDEX/search/ana',
    '/index/SEARCH/ana'
  ]
  for (const url of bad) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, url + ' -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
    t.absent(got.body.toString().includes('ana'), 'nothing of the path is echoed')
    t.is(got.headers['cache-control'], 'no-store')
    t.is(got.headers['x-content-type-options'], 'nosniff')
  }
  t.is(seeder.calls.length, 0, 'malformed segments never reach the seeder')
})

test('startSeedWs /index/search: Host is checked first (421), other methods are 405 with Allow', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const url = '/index/search/ana'
  t.is((await mediaRequest(server.port, url, { host: 'evil.example:' + server.port })).status, 421, 'foreign Host -> 421')
  t.is((await mediaRequest(server.port, url, { method: 'POST', host: 'evil.example:' + server.port })).status, 421, 'the Host check runs before the method check')
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const got = await mediaRequest(server.port, url, { method })
    t.is(got.status, 405, method + ' -> 405')
    t.is(got.headers.allow, 'GET, HEAD')
  }
  t.is(seeder.calls.length, 0, 'refused requests never reach the seeder')
})

test('startSeedWs /index/search: a null answer, a throw, a rejection, a non-object and a missing method are 404, nothing echoed', async (t) => {
  t.timeout(20000)
  const answers = [
    () => null,
    () => { throw new Error('secret ana') },
    () => Promise.reject(new Error('secret ana')),
    () => [1, 2, 3],
    () => 'ana'
  ]
  for (const answer of answers) {
    const seeder = indexSeeder()
    seeder.indexSearch = answer
    const server = await startSeedWs({ port: 0, seeder })
    const got = await mediaRequest(server.port, '/index/search/ana')
    await server.close()
    t.is(got.status, 404)
    t.is(got.body.toString(), 'não encontrado\n')
    t.absent(got.body.toString().includes('secret'), 'nothing of the error is echoed')
  }
  const old = await startSeedWs({ port: 0, seeder: stubSeeder('ok') })
  t.teardown(() => old.close(), { force: true })
  const got = await mediaRequest(old.port, '/index/search/ana')
  t.is(got.status, 404, 'a seeder without indexSearch -> 404')
  t.is(got.body.toString(), 'não encontrado\n')
})

test('startSeedWs /index/search: the worst-case answer stays within 64 KiB; an oversize answer is 404', async (t) => {
  t.timeout(20000)
  const hex = (i) => i.toString(16).padStart(64, '0')
  const member = (i) => ({ author: hex(i), profileSeq: Number.MAX_SAFE_INTEGER, usernameSeq: Number.MAX_SAFE_INTEGER })
  const worst = { members: Array.from({ length: 20 }, (_, i) => member(i)), more: true, indexing: true, complete: false }
  const seeder = indexSeeder()
  seeder.indexSearch = async () => worst
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const got = await mediaRequest(server.port, '/index/search/ana')
  t.is(got.status, 200)
  t.ok(got.body.byteLength <= INDEX_MAX_BODY, 'search worst case is ' + got.body.byteLength + ' bytes <= ' + INDEX_MAX_BODY)
  t.alike(JSON.parse(got.body.toString()), worst)

  seeder.indexSearch = async () => ({ ...worst, members: Array.from({ length: 2000 }, (_, i) => member(i)) })
  const over = await mediaRequest(server.port, '/index/search/ana')
  t.is(over.status, 404, 'an answer over INDEX_MAX_BODY is never sent')
  t.is(over.body.toString(), 'não encontrado\n')
})

test('startSeedWs /index/search: shares the index token bucket with the other /index routes', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder, index: { rate: 0, burst: 1 } })
  t.teardown(() => server.close(), { force: true })
  t.is((await mediaRequest(server.port, '/index/search/ana')).status, 200, 'the search spends the only token')
  const member = await mediaRequest(server.port, '/index/member/' + A)
  t.is(member.status, 503, 'the next /index request finds the shared bucket empty')
  t.is(member.headers['retry-after'], '1')
  t.alike(seeder.calls, [['indexSearch', 'ana']])
})

// /index/topic: the fourth route on the same serveIndex discipline. The
// words reach the seeder only in their folded, strictly matched form; any
// other spelling is the generic 404 without a seeder call.
test('startSeedWs /index/topic: the regex is exported with its documented value', async (t) => {
  t.is(INDEX_TOPIC_RE.source, '^\\/index\\/topic\\/([a-z0-9]{2,32}(?:\\+[a-z0-9]{2,32}){0,7})(?:\\/([0-9]{1,16}\\.[0-9a-f]{64}\\.[1-9][0-9]{0,14}))?$')
  t.ok(INDEX_TOPIC_RE.test('/index/topic/' + Array.from({ length: 8 }, () => 'ab').join('+')), '8 tokens')
  t.ok(INDEX_TOPIC_RE.test('/index/topic/' + 'a'.repeat(32)), 'a 32-char token')
})

test('startSeedWs /index/topic: GET answers JSON with the words and cursor as given, HEAD sends the headers only', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const hit = { items: [A + ':1'], next: null, authors: { [A]: { profileSeq: 1, usernameSeq: null } }, indexing: false, complete: true }

  const got = await mediaRequest(server.port, '/index/topic/ceu+azul')
  t.is(got.status, 200)
  jsonHeaders(t, got)
  t.is(got.headers['content-length'], String(got.body.byteLength))
  t.alike(JSON.parse(got.body.toString()), hit)
  t.alike(seeder.calls[0], ['indexTopic', 'ceu+azul', null], 'no cursor -> null; the + is literal')

  const paged = await mediaRequest(server.port, '/index/topic/ceu+azul/' + CURSOR)
  t.is(paged.status, 200)
  t.alike(seeder.calls[1], ['indexTopic', 'ceu+azul', CURSOR], 'the cursor is passed as a string')

  const head = await mediaRequest(server.port, '/index/topic/ceu+azul', { method: 'HEAD' })
  t.is(head.status, 200)
  jsonHeaders(t, head)
  t.is(head.headers['content-length'], got.headers['content-length'], 'HEAD announces the GET length')
  t.is(head.body.byteLength, 0, 'HEAD has no body')
  t.alike(seeder.calls[2], ['indexTopic', 'ceu+azul', null])

  const unknown = await mediaRequest(server.port, '/index/topic/xyz')
  t.is(unknown.status, 200, 'an unknown word is a 200')
  t.alike(JSON.parse(unknown.body.toString()).items, [])
  t.alike(seeder.calls[3], ['indexTopic', 'xyz', null])
})

test('startSeedWs /index/topic: malformed, encoded, uppercase or query paths never reach the seeder and are the same 404', async (t) => {
  t.timeout(20000)
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const bad = [
    '/index/topic',
    '/index/topic/',
    '/index/topic/a',
    '/index/topic/CEU',
    '/index/topic/c%C3%A9u',
    '/index/topic/ceu%2Bazul',
    '/index/topic/ceu+azul?x=1',
    '/index/topic/ceu+azul/',
    '/index/topic/' + 'a'.repeat(33),
    '/index/topic/' + Array.from({ length: 9 }, () => 'ab').join('+'),
    '/index/topic/ceu/1700000000000.' + B.toUpperCase() + '.7',
    '/index/topic/ceu/1700000000000.' + B + '.07'
  ]
  for (const url of bad) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, url.slice(0, 40) + '... -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
    t.is(got.headers['cache-control'], 'no-store')
    t.absent(got.body.toString().includes('search'), 'the path is not echoed')
    t.absent(got.body.toString().includes('ceu'), 'the words are not echoed')
  }
  t.is(seeder.calls.length, 0, 'malformed paths never reach the seeder')
})

test('startSeedWs /index/topic: a null answer, a throw and a seeder without indexTopic are 404, nothing echoed', async (t) => {
  t.timeout(20000)
  const nulls = indexSeeder()
  nulls.indexTopic = async (path, cursor) => { nulls.calls.push(['indexTopic', path, cursor]); return null }
  const s1 = await startSeedWs({ port: 0, seeder: nulls })
  t.teardown(() => s1.close(), { force: true })
  const n = await mediaRequest(s1.port, '/index/topic/ceu+azul')
  t.is(n.status, 404, 'null answer -> 404')
  t.is(n.body.toString(), 'não encontrado\n')
  t.is(nulls.calls.length, 1, 'the seeder was asked')

  const throwing = indexSeeder()
  throwing.indexTopic = () => { throw new Error('secret ceu+azul') }
  const s2 = await startSeedWs({ port: 0, seeder: throwing })
  t.teardown(() => s2.close(), { force: true })
  const th = await mediaRequest(s2.port, '/index/topic/ceu+azul')
  t.is(th.status, 404, 'throw -> 404')
  t.is(th.body.toString(), 'não encontrado\n')
  t.absent(th.body.toString().includes('secret'), 'nothing of the error is echoed')
  t.absent(th.body.toString().includes('ceu'), 'the words are not echoed')

  const old = await startSeedWs({ port: 0, seeder: stubSeeder('ok') })
  t.teardown(() => old.close(), { force: true })
  const o = await mediaRequest(old.port, '/index/topic/ceu+azul')
  t.is(o.status, 404, 'a seeder without indexTopic -> 404')
  t.is(o.body.toString(), 'não encontrado\n')
})

test('startSeedWs /index/topic: shares the /index token bucket and in-flight cap', async (t) => {
  t.timeout(30000)
  const s1 = await startSeedWs({ port: 0, seeder: indexSeeder(), index: { rate: 0.001, burst: 3 } })
  t.teardown(() => s1.close(), { force: true })
  for (let i = 0; i < 3; i++) t.is((await mediaRequest(s1.port, '/index/topic/ceu')).status, 200, 'within the burst')
  const over = await mediaRequest(s1.port, '/index/counts/' + A + ':1')
  t.is(over.status, 503, 'searches spent the shared bucket')
  t.is(over.body.toString(), 'ocupado\n')
  t.is(over.headers['retry-after'], '1')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const seeder = indexSeeder({ gate })
  const s2 = await startSeedWs({ port: 0, seeder, index: { maxInFlight: 2 } })
  t.teardown(() => s2.close(), { force: true })
  const held = [mediaRequest(s2.port, '/index/topic/ceu'), mediaRequest(s2.port, '/index/topic/ceu+azul')]
  await until(() => seeder.calls.length === 2, { name: 'duas buscas retidas', timeoutMs: 5000 })
  const busy = await mediaRequest(s2.port, '/index/member/' + A)
  t.is(busy.status, 503, 'searches hold the shared in-flight slots')
  t.is(busy.headers['retry-after'], '1')
  t.is(seeder.calls.length, 2, 'a refused request never reaches the seeder')
  release()
  t.alike((await Promise.all(held)).map((r) => r.status), [200, 200])
})

test('startSeedWs /index/topic: the worst-case answer stays within 64 KiB', async (t) => {
  t.timeout(20000)
  const hex = (i) => i.toString(16).padStart(64, '0')
  const seq = '9'.repeat(15)
  const items = []
  const authors = {}
  for (let i = 0; i < 30; i++) {
    items.push(hex(i) + ':' + seq)
    authors[hex(i)] = { profileSeq: Number(seq), usernameSeq: Number(seq) }
  }
  const worst = { items, next: '9'.repeat(16) + '.' + hex(29) + '.' + seq, authors, indexing: true, complete: false }
  t.is(Object.keys(authors).length, 30, '30 distinct author hints')
  const seeder = indexSeeder()
  seeder.indexTopic = async () => worst
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const got = await mediaRequest(server.port, '/index/topic/' + Array.from({ length: 8 }, () => 'a'.repeat(32)).join('+') + '/' + CURSOR)
  t.is(got.status, 200)
  t.ok(got.body.byteLength <= INDEX_MAX_BODY, 'worst case is ' + got.body.byteLength + ' bytes <= ' + INDEX_MAX_BODY)
  t.alike(JSON.parse(got.body.toString()), worst)
})

// Account search and topic search share /index but never a route: a word
// valid for both reaches only the method its prefix names.
test('startSeedWs /index/search and /index/topic: the same word reaches only its own method', async (t) => {
  t.timeout(20000)
  t.absent(INDEX_SEARCH_RE.test('/index/topic/ceu'), 'the account regex refuses the topic route')
  t.absent(INDEX_TOPIC_RE.test('/index/search/ceu'), 'the topic regex refuses the account route')
  const seeder = indexSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  t.is((await mediaRequest(server.port, '/index/topic/ceu')).status, 200)
  t.is((await mediaRequest(server.port, '/index/search/ceu')).status, 200)
  t.alike(seeder.calls, [['indexTopic', 'ceu', null], ['indexSearch', 'ceu']])
})

// /index/group, /index/groups, /index/group-search: the seeder's group
// answers shaped into the wire bodies. The stub answers in the shapes the
// real Seeder returns (the end-to-end test below pins them).
const G = 'd'.repeat(64)
const W = 'e'.repeat(64)
const groupHeader = { kind: 'group', visibility: 'public', join: 'open', diary: A, name: 'Jardim' }

function groupSeeder () {
  const stub = indexSeeder()
  stub.indexGroup = async (group, after) => {
    stub.calls.push(['indexGroup', group, after])
    if (group !== G) return null
    return { header: groupHeader, rootServed: true, writers: [{ key: W, diary: A, length: 3, seq: 1, left: false }], next: null, indexing: false, complete: true }
  }
  stub.indexGroups = async (diary) => {
    stub.calls.push(['indexGroups', diary])
    return diary === A ? { groups: [{ group: G, writer: W, seq: 1, left: false }], indexing: false, complete: true } : null
  }
  stub.indexGroupSearch = async (segment) => {
    stub.calls.push(['indexGroupSearch', segment])
    return segment === 'jardim' ? { groups: [{ group: G, name: 'Jardim', members: 2 }], more: false, indexing: false, complete: true } : null
  }
  return stub
}

test('startSeedWs /index/group*: routes answer the wire shapes; HEAD the headers only; unknown or blocked is 404', async (t) => {
  t.timeout(20000)
  const seeder = groupSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const g = await mediaRequest(server.port, '/index/group/' + G)
  t.is(g.status, 200)
  jsonHeaders(t, g)
  t.alike(JSON.parse(g.body.toString()), {
    kind: 'group',
    visibility: 'public',
    join: 'open',
    name: 'Jardim',
    creator: A,
    rootServed: true,
    writers: [{ key: W, diary: A, length: 3, seq: 1, left: false }],
    next: null,
    indexing: false,
    complete: true
  })
  t.alike(seeder.calls[0], ['indexGroup', G, null])
  t.is((await mediaRequest(server.port, '/index/group/' + G + '/' + W)).status, 200)
  t.alike(seeder.calls[1], ['indexGroup', G, W], 'the cursor reaches the seeder')

  const gs = await mediaRequest(server.port, '/index/groups/' + A)
  t.is(gs.status, 200)
  t.alike(JSON.parse(gs.body.toString()), { groups: [{ group: G, writer: W, seq: 1, left: false }], indexing: false, complete: true })

  const found = await mediaRequest(server.port, '/index/group-search/jardim')
  t.is(found.status, 200)
  t.alike(JSON.parse(found.body.toString()), { groups: [{ group: G, name: 'Jardim', writerCount: 2 }], more: false, indexing: false, complete: true })

  const head = await mediaRequest(server.port, '/index/group/' + G, { method: 'HEAD' })
  t.is(head.status, 200)
  jsonHeaders(t, head)
  t.is(head.headers['content-length'], g.headers['content-length'])
  t.is(head.body.byteLength, 0)

  for (const url of ['/index/group/' + 'f'.repeat(64), '/index/groups/' + 'f'.repeat(64), '/index/group-search/zzz']) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, url + ' unknown -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
  }
})

test('startSeedWs /index/group*: malformed paths never reach the seeder; Host 421 and method 405 policy', async (t) => {
  t.timeout(20000)
  const seeder = groupSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  t.ok(INDEX_GROUP_RE.test('/index/group/' + G + '/' + W))
  t.ok(INDEX_GROUPS_RE.test('/index/groups/' + A))
  t.ok(INDEX_GROUP_SEARCH_RE.test('/index/group-search/a-b'))
  const bad = [
    '/index/group', '/index/group/', '/index/group/' + 'a'.repeat(63), '/index/group/' + 'A'.repeat(64),
    '/index/group/' + G + '/', '/index/group/' + G + '/abc', '/index/group/' + G + '/' + W + '/' + W,
    '/index/group/' + G + '?x=1', '/index/groups', '/index/groups/' + A + '/x', '/index/groups/' + 'a'.repeat(65),
    '/index/group-search', '/index/group-search/', '/index/group-search/Ana', '/index/group-search/a-b-c-d-e',
    '/index/group-search/' + 'a'.repeat(21), '/index/group-search/%61na'
  ]
  for (const url of bad) {
    const got = await mediaRequest(server.port, url)
    t.is(got.status, 404, url + ' -> 404')
    t.is(got.body.toString(), 'não encontrado\n')
  }
  t.is(seeder.calls.length, 0, 'malformed paths never reach the seeder')
  const url = '/index/group/' + G
  t.is((await mediaRequest(server.port, url, { host: 'evil.example:' + server.port })).status, 421)
  t.is((await mediaRequest(server.port, url, { method: 'POST', host: 'evil.example:' + server.port })).status, 421)
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const got = await mediaRequest(server.port, url, { method })
    t.is(got.status, 405, method + ' -> 405')
    t.is(got.headers.allow, 'GET, HEAD')
  }
  t.is(seeder.calls.length, 0)
})

// The real Seeder's group answers through the routes, so the stub above and
// the Seeder cannot drift apart: the index is fed as the seeder feeds it
// (a validated root header, writer bindings) and the served state is set
// to what an admitted diary and gated group cores leave behind.
test('startSeedWs /index/group*: the real Seeder\'s answers carry the public name and one row per group', async (t) => {
  t.timeout(20000)
  const seeder = new Seeder({ dataDir: tmpDir(t, 'varanda-seed-') })
  seeder._ready = true
  const B = 'b'.repeat(64)
  const P = 'a'.repeat(64)
  const core = { contiguousLength: 2, length: 2 }
  for (const diary of [A, B]) {
    seeder._admitted.set(diary, {})
    seeder._served.set(diary, { core, gated: true, dropped: false, scanQueued: false, scanned: 2, groupLive: new Map() })
  }
  const writers = [G, P, W, 'f'.repeat(64)]
  for (const key of writers) seeder._groupServed.set(key, { core, headerOk: true, dropped: false })
  seeder._groupIndex.setHeader(G, makeGroupHeader({ diary: A, name: 'Jardim Botânico' }))
  seeder._groupIndex.setHeader(P, makeGroupHeader({ diary: A, visibility: 'private', join: 'approval', name: null, box: 'e'.repeat(64) }))
  seeder._groupIndex.addWriter(G, G, A, 1)
  seeder._groupIndex.addWriter(P, P, A, 2)
  // B joined G from two devices.
  seeder._groupIndex.addWriter(G, W, B, 1)
  seeder._groupIndex.addWriter(G, 'f'.repeat(64), B, 2)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const g = JSON.parse((await mediaRequest(server.port, '/index/group/' + G)).body.toString())
  t.is(g.name, 'Jardim Botânico', 'the public root\'s display name')
  t.is(g.creator, A)
  t.is(g.writers.length, 3)
  const p = JSON.parse((await mediaRequest(server.port, '/index/group/' + P)).body.toString())
  t.is(p.visibility, 'private')
  t.is(p.name, null, 'a private root has no name')
  const found = JSON.parse((await mediaRequest(server.port, '/index/group-search/jardim')).body.toString())
  t.alike(found.groups, [{ group: G, name: 'Jardim Botânico', writerCount: 2 }])
  const gs = JSON.parse((await mediaRequest(server.port, '/index/groups/' + B)).body.toString())
  t.alike(gs.groups, [{ group: G, writer: 'f'.repeat(64), seq: 2, left: false }], 'one row per group, the newest join')
})

test('startSeedWs /index/group*: a throw or a seeder without the methods is 404; worst-case bodies stay within 64 KiB', async (t) => {
  t.timeout(20000)
  const hex = (i) => i.toString(16).padStart(64, '0')
  const max = Number.MAX_SAFE_INTEGER
  const seeder = groupSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  // A lone surrogate is the costliest JSON character (6 bytes, \udXXX).
  const name = '\ud800'.repeat(MAX_GROUP_NAME)
  const writers = Array.from({ length: 64 }, (_, i) => ({ key: hex(i), diary: hex(100 + i), length: max, seq: max, left: true }))
  seeder.indexGroup = async () => ({ header: { ...groupHeader, name }, writers, next: hex(63), indexing: true, complete: false })
  const g = await mediaRequest(server.port, '/index/group/' + G + '/' + W)
  t.is(g.status, 200)
  t.ok(g.body.byteLength <= INDEX_MAX_BODY, 'group worst case is ' + g.body.byteLength + ' bytes')
  t.ok(g.body.byteLength > 8192, 'a real page')

  const groups = Array.from({ length: MAX_GROUPS_PER_DIARY }, (_, i) => ({ group: hex(i), writer: hex(1000 + i), seq: max, left: true }))
  seeder.indexGroups = async () => ({ groups, indexing: true, complete: false })
  const gs = await mediaRequest(server.port, '/index/groups/' + A)
  t.is(gs.status, 200)
  t.ok(gs.body.byteLength <= INDEX_MAX_BODY, 'groups worst case is ' + gs.body.byteLength + ' bytes')

  const hits = Array.from({ length: 20 }, (_, i) => ({ group: hex(i), name, members: max }))
  seeder.indexGroupSearch = async () => ({ groups: hits, more: true, indexing: true, complete: false })
  const gsr = await mediaRequest(server.port, '/index/group-search/jardim')
  t.is(gsr.status, 200)
  t.ok(gsr.body.byteLength <= INDEX_MAX_BODY, 'search worst case is ' + gsr.body.byteLength + ' bytes')

  seeder.indexGroups = async () => ({ groups: Array.from({ length: 3000 }, (_, i) => ({ group: hex(i), writer: hex(i), seq: max, left: true })), indexing: true, complete: false })
  const over = await mediaRequest(server.port, '/index/groups/' + A)
  t.is(over.status, 404, 'an answer over INDEX_MAX_BODY is never sent')

  seeder.indexGroup = async () => { throw new Error('secret') }
  const thrown = await mediaRequest(server.port, '/index/group/' + G)
  t.is(thrown.status, 404)
  t.absent(thrown.body.toString().includes('secret'))

  const old = await startSeedWs({ port: 0, seeder: stubSeeder('ok') })
  t.teardown(() => old.close(), { force: true })
  t.is((await mediaRequest(old.port, '/index/group/' + G)).status, 404, 'a seeder without the methods -> 404')
})

// GET /moderation-group-post/<W>/<seq>: the account service's read of the
// reported group message (Seeder#groupPostBlock behind it), gated like
// /moderation-post by the triage token.
const GP_TOKEN = 'd4'.repeat(32)
const GP_W = 'e'.repeat(64)
const GP_G = '1'.repeat(64)
const GP_D = '2'.repeat(64)

function groupPostRequest (port, url, { token = GP_TOKEN, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (token !== null) headers.Authorization = 'Bearer ' + token
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b4a.toString(b4a.concat(chunks)) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function groupPostSeeder () {
  const stub = stubSeeder()
  stub.calls = []
  stub.groupPostBlock = async (writer, seq) => {
    stub.calls.push([writer, seq])
    if (writer !== GP_W) return null
    if (seq === 2) return { group: GP_G, diary: GP_D, seq, texto: 'olá <b>grupo</b>', resposta: { writer: GP_W, seq: 1 } }
    if (seq === 3) return { group: GP_G, diary: GP_D, seq, texto: 'sem resposta', resposta: null }
    if (seq === 4) return { group: GP_G, diary: 'zz', seq, texto: 'forma errada', resposta: null }
    return null
  }
  return stub
}

test('GROUP_POST_RE: canonical keys and sequence numbers only', (t) => {
  t.ok(GROUP_POST_RE.test('/moderation-group-post/' + GP_W + '/1'))
  t.ok(GROUP_POST_RE.test('/moderation-group-post/' + GP_W + '/' + '9'.repeat(15)))
  t.absent(GROUP_POST_RE.test('/moderation-group-post/' + GP_W + '/0'))
  t.absent(GROUP_POST_RE.test('/moderation-group-post/' + GP_W + '/01'))
  t.absent(GROUP_POST_RE.test('/moderation-group-post/' + GP_W + '/' + '9'.repeat(16)))
  t.absent(GROUP_POST_RE.test('/moderation-group-post/' + 'E'.repeat(64) + '/1'))
  t.absent(GROUP_POST_RE.test('/moderation-group-post/' + GP_W + '/1?x=1'))
})

test('GET /moderation-group-post: the validated group-post with the token, the generic 404 otherwise', async (t) => {
  t.timeout(20000)
  const seeder = groupPostSeeder()
  const server = await startSeedWs({ port: 0, seeder, triageToken: GP_TOKEN })
  t.teardown(() => server.close(), { force: true })
  const url = (w, seq) => '/moderation-group-post/' + w + '/' + seq

  const ok = await groupPostRequest(server.port, url(GP_W, 2))
  t.is(ok.status, 200)
  t.is(ok.headers['cache-control'], 'no-store')
  t.alike(JSON.parse(ok.body), { group: GP_G, diary: GP_D, seq: 2, texto: 'olá <b>grupo</b>', resposta: { writer: GP_W, seq: 1 } })
  t.alike(JSON.parse((await groupPostRequest(server.port, url(GP_W, 3))).body).resposta, null)

  const notFound = async (res, name) => {
    t.is(res.status, 404, name)
    t.is(res.body, 'não encontrado\n', name + ': generic body')
    t.absent(res.body.includes(GP_W), name + ': nothing echoed')
  }
  await notFound(await groupPostRequest(server.port, url('f'.repeat(64), 2)), 'unknown writer')
  await notFound(await groupPostRequest(server.port, url(GP_W, 5)), 'not a group-post')
  await notFound(await groupPostRequest(server.port, url(GP_W, 4)), 'a malformed answer')
  const before = seeder.calls.length
  await notFound(await groupPostRequest(server.port, url(GP_W, 2), { token: null }), 'missing token')
  await notFound(await groupPostRequest(server.port, url(GP_W, 2), { token: 'ab'.repeat(32) }), 'wrong token')
  await notFound(await groupPostRequest(server.port, url(GP_W, 2), { token: 'x' }), 'short token')
  t.is(seeder.calls.length, before, 'the seeder is never asked without the token')
  await notFound(await groupPostRequest(server.port, url(GP_W, 2) + '?a=1'), 'a query string')
  const head = await groupPostRequest(server.port, url(GP_W, 2), { method: 'HEAD' })
  t.is(head.status, 405)
  t.is(head.headers.allow, 'GET')

  // No triage token configured: the route does not exist at all.
  const plain = await startSeedWs({ port: 0, seeder: groupPostSeeder() })
  t.teardown(() => plain.close(), { force: true })
  await notFound(await groupPostRequest(plain.port, url(GP_W, 2)), 'no triageToken')
})

test('/index/group and /index/groups with the triage token use the moderation budget; a wrong token is public', async (t) => {
  t.timeout(20000)
  const seeder = groupSeeder()
  const server = await startSeedWs({ port: 0, seeder, triageToken: GP_TOKEN, index: { rate: 0.001, burst: 1 } })
  t.teardown(() => server.close(), { force: true })
  const public1 = await groupPostRequest(server.port, '/index/group/' + G, { token: null })
  t.is(public1.status, 200, 'the one public token')
  t.is((await groupPostRequest(server.port, '/index/group/' + G, { token: null })).status, 503, 'the public bucket is empty')
  t.is((await groupPostRequest(server.port, '/index/groups/' + A, { token: 'ab'.repeat(32) })).status, 503, 'a wrong token is a public request')
  const viaToken = await groupPostRequest(server.port, '/index/group/' + G)
  t.is(viaToken.status, 200, 'the token still answers')
  t.is(viaToken.body, public1.body, 'with the same body')
  t.is((await groupPostRequest(server.port, '/index/groups/' + A)).status, 200)
  t.is((await groupPostRequest(server.port, '/index/group-search/jardim')).status, 503, 'other index routes stay public')
})
