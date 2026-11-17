// The client address seed-ws hands to Seeder#acceptStream (issue #32): the
// pure clientAddress rule, the address reaching acceptStream, and a WebSocket
// displaced by another address closed with 1013 like a refused one.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { attachAdmission, generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { startSeedWs, clientAddress, isLocalClient } = require('../lib/seed-ws')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function within (promise, ms, name) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(name + ' não terminou em ' + ms + ' ms')), ms) })
  ]).finally(() => clearTimeout(timer))
}

const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } })

test('clientAddress: X-Forwarded-For counts only on a loopback connection, last entry', (t) => {
  t.is(clientAddress(req('127.0.0.1')), '127.0.0.1', 'loopback without the header: the TCP peer')
  t.is(clientAddress(req('127.0.0.1', '198.51.100.7')), '198.51.100.7')
  t.is(clientAddress(req('127.0.0.1', '10.0.0.1, 198.51.100.7 ')), '198.51.100.7', 'last entry, trimmed')
  t.is(clientAddress(req('127.9.8.7', '198.51.100.7')), '198.51.100.7', '127.0.0.0/8')
  t.is(clientAddress(req('::1', '2001:db8::1')), '2001:db8::1', '::1')
  t.is(clientAddress(req('::ffff:127.0.0.1', '198.51.100.7')), '198.51.100.7', 'IPv4-mapped loopback')
  t.is(clientAddress(req('::FFFF:127.0.0.1', '198.51.100.7')), '198.51.100.7', 'any case')
  t.is(clientAddress(req('203.0.113.5', '198.51.100.7')), '203.0.113.5', 'a non-loopback peer cannot pick its address')
  t.is(clientAddress(req('::ffff:203.0.113.5', '198.51.100.7')), '::ffff:203.0.113.5')
  t.is(clientAddress(req('128.0.0.1', '198.51.100.7')), '128.0.0.1')
  t.is(clientAddress(req('127.0.0.1', '')), '', 'an empty header is an empty (unknown) address')
  t.is(clientAddress({ socket: {}, headers: {} }), null, 'no address')
  t.is(clientAddress(null), null)
})

test('isLocalClient: only a loopback connection with no X-Forwarded-For', (t) => {
  t.ok(isLocalClient(req('127.0.0.1')), 'a process on this host')
  t.ok(isLocalClient(req('::1')))
  t.ok(isLocalClient(req('::ffff:127.0.0.1')))
  t.absent(isLocalClient(req('127.0.0.1', '198.51.100.7')), 'through the proxy')
  t.absent(isLocalClient(req('127.0.0.1', '')), 'an empty header still came through a proxy')
  t.absent(isLocalClient(req('203.0.113.5')), 'a remote peer')
  t.absent(isLocalClient({ socket: {}, headers: {} }))
  t.absent(isLocalClient(null))
})

// A seeder stub that records each acceptStream call.
function stubSeeder () {
  const calls = []
  return {
    calls,
    accepting: () => true,
    stats: () => ({ status: 'ok' }),
    acceptStream (duplex, opts) {
      calls.push({ duplex, opts })
      duplex.on('error', () => {})
      return { destroy () {} }
    }
  }
}

function openWs (t, port, headers = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder', { headers })
  ws.on('error', () => {})
  t.teardown(() => ws.terminate(), { force: true })
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  return within(new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, closed }))
    ws.once('unexpected-response', () => reject(new Error('upgrade recusado')))
  }), 5000, 'open')
}

test('startSeedWs: the client address reaches acceptStream', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  await openWs(t, server.port)
  await openWs(t, server.port, { 'X-Forwarded-For': '203.0.113.9, 198.51.100.4' })
  await until(() => seeder.calls.length === 2, { name: 'duas chamadas' })
  t.is(seeder.calls[0].opts.address, '127.0.0.1', 'direct loopback client: its TCP address')
  t.is(seeder.calls[1].opts.address, '198.51.100.4', 'behind the proxy: the last X-Forwarded-For entry')
  t.is(typeof seeder.calls[1].opts.onRefuse, 'function')
  t.is(seeder.calls[0].opts.local, true, 'direct loopback client: local')
  t.is(seeder.calls[1].opts.local, false, 'behind the proxy: not local')
})

// An unmasked server close frame: FIN + opcode 8, length 8, code 1013, 'lotado'.
const CLOSE_1013_LOTADO = Buffer.concat([Buffer.from([0x88, 0x08, 0x03, 0xf5]), Buffer.from('lotado')])

// A raw client that completes the upgrade and never answers a close frame.
// Resolves { bytes, heldMs } once the server closes the connection.
function mutedClient (t, port) {
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

test('startSeedWs: a displaced stream that keeps writing still closes with 1013 after the grace', async (t) => {
  t.timeout(20000)
  const seeder = stubSeeder()
  // A displaced stream was already serving: the seeder side may write right
  // after the handoff (a keep-alive). That write must not reach ws.send on
  // the CLOSING socket, which would terminate it at once.
  seeder.acceptStream = (duplex, opts) => {
    duplex.on('error', () => {})
    setTimeout(() => {
      opts.onRefuse({ reason: 'connection-displaced' })
      duplex.write(b4a.from('keep-alive'))
    }, 50)
    return { destroy () {} }
  }
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const raw = await mutedClient(t, server.port)
  t.ok(raw.bytes.includes(CLOSE_1013_LOTADO), 'the 1013 lotado close frame arrived')
  t.ok(raw.heldMs >= 500, 'the server waited for the close handshake (' + raw.heldMs + ' ms), the write did not terminate it')
  t.ok(raw.heldMs < 3000, 'and destroyed the socket after the grace')
})

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return dataDir
}

// A member over a WebSocket from `address` (as Caddy would forward it): a
// Noise initiator and an admission channel, so the stream carries traffic.
async function wsMember (t, port, address) {
  const { ws, closed } = await openWs(t, port, { 'X-Forwarded-For': address })
  const duplex = createWebSocketStream(ws)
  duplex.on('error', () => {})
  const keyPair = generateNoiseKeyPair()
  const noise = new NoiseSecretStream(true, duplex, { keyPair })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await within(new Promise((resolve) => noise.once('connect', resolve)), 10000, 'handshake')
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  store.replicate(noise)
  const peer = attachAdmission(noise, { role: 'member', have: [] })
  await within(peer.hello, 10000, 'hello')
  return { ws, closed, key: hex(keyPair.publicKey) }
}

test('startSeedWs + Seeder: a WebSocket displaced by another address is closed with 1013', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const dataDir = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: assoc.hex, maxExternal: 2, log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })

  const a1 = await wsMember(t, server.port, '203.0.113.1')
  const a2 = await wsMember(t, server.port, '203.0.113.1')
  t.is(seeder.stats().external, 2, 'one address fills maxExternal')

  const b = await wsMember(t, server.port, '203.0.113.2')
  const { code, reason } = await within(a2.closed, 5000, 'close do deslocado')
  t.is(code, 1013, 'the displaced WebSocket is closed with 1013 (try again later)')
  t.is(reason, 'lotado')
  const ev = events.filter((e) => e.event === 'peer-dropped' && e.reason === 'connection-displaced')
  t.is(ev.length, 1)
  t.is(ev[0].peerKey, a2.key, 'the newest connection of the address with more slots')
  t.absent(JSON.stringify(events).includes('203.0.113'), 'no address in any event')
  t.is(a1.ws.readyState, WebSocket.OPEN, 'the other connection of that address stays')
  t.is(b.ws.readyState, WebSocket.OPEN, 'the newcomer stays')
  await until(() => seeder.stats().external === 2, { name: 'two live external slots' })
})
