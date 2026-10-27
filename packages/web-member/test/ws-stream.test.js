// wsStream over Node's ws on loopback: a Noise handshake completes through
// it, a 64 KiB echo round-trips, destroying one side closes the other and a
// text frame destroys the stream.
const test = require('brittle')
const { WebSocketServer, WebSocket } = require('ws')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { wsStream, guardedWsStream } = require('../lib/ws-stream')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function closed (stream) {
  if (stream.destroyed) return Promise.resolve()
  return new Promise((resolve) => stream.once('close', resolve))
}

// A server whose connections become Noise responders with a fixed key pair.
async function noiseServer (t, keyPair) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => new Promise((resolve) => wss.close(() => resolve())), { force: true })
  const responders = []
  wss.on('connection', (ws) => {
    const duplex = wsStream(ws)
    duplex.on('error', () => {})
    const noise = new NoiseSecretStream(false, duplex, { keyPair })
    noise.on('error', () => {})
    t.teardown(() => noise.destroy(), { force: true })
    responders.push({ ws, duplex, noise })
  })
  return { wss, port: wss.address().port, responders }
}

function noiseClient (t, port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port)
  // Wrapped while CONNECTING: the handshake bytes are buffered until 'open'.
  const duplex = wsStream(ws)
  duplex.on('error', () => {})
  const noise = new NoiseSecretStream(true, duplex, { keyPair: crypto.keyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  return { ws, duplex, noise }
}

function connected (noise) {
  return new Promise((resolve, reject) => {
    noise.once('connect', resolve)
    noise.once('close', () => reject(new Error('fechado antes do handshake')))
  })
}

test('Noise handshake and a 64 KiB echo over wsStream', async (t) => {
  await testnet(t)
  const serverKp = crypto.keyPair()
  const { port, responders } = await noiseServer(t, serverKp)
  const client = noiseClient(t, port)
  t.is(client.ws.readyState, WebSocket.CONNECTING, 'wrapped before open')
  await connected(client.noise)
  await until(() => responders.length === 1, { name: 'responder' })
  const responder = responders[0]
  await connected(responder.noise)
  t.is(hex(client.noise.remotePublicKey), hex(serverKp.publicKey), 'initiator sees the responder key')
  t.is(hex(responder.noise.remotePublicKey), hex(client.noise.publicKey))
  t.is(client.ws.binaryType, 'arraybuffer')

  responder.noise.on('data', (chunk) => responder.noise.write(chunk))
  const payload = b4a.allocUnsafe(64 * 1024)
  for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff
  const received = []
  let total = 0
  const done = new Promise((resolve) => {
    client.noise.on('data', (chunk) => {
      received.push(chunk)
      total += chunk.byteLength
      if (total >= payload.byteLength) resolve()
    })
  })
  client.noise.write(payload)
  await done
  t.is(total, payload.byteLength)
  t.ok(b4a.equals(b4a.concat(received), payload), '64 KiB echoed intact')

  // Destroying one side closes the other.
  client.noise.destroy()
  await closed(responder.noise)
  t.ok(responder.noise.destroyed, 'responder closed by the client destroy')
  await until(() => client.ws.readyState === WebSocket.CLOSED && responder.ws.readyState === WebSocket.CLOSED, { name: 'sockets fechados' })
  t.pass('both sockets closed')
})

test('a text frame destroys the stream', async (t) => {
  await testnet(t)
  const { port, responders } = await noiseServer(t, crypto.keyPair())
  const client = noiseClient(t, port)
  await connected(client.noise)
  await until(() => responders.length === 1, { name: 'responder' })
  const responder = responders[0]
  await connected(responder.noise)
  const errors = []
  responder.duplex.on('error', (err) => errors.push(err))
  client.ws.send('texto')
  await closed(responder.duplex)
  t.ok(responder.duplex.destroyed, 'server-side stream destroyed')
  t.ok(errors.some((e) => /quadro de texto/.test(e.message)), 'destroyed with the text-frame error')
  await closed(responder.noise)
  await closed(client.noise)
  t.ok(client.noise.destroyed, 'client side closed too')
})

// guardedWsStream on the initiator: the Noise XX initiator receives ONE
// handshake frame (msg2), so the responder's first post-handshake frame,
// over the 1024-byte handshake bound but under maxFrame, must be forwarded.
test('guardedWsStream: a second incoming frame over 1024 bytes but under maxFrame reaches the initiator', async (t) => {
  await testnet(t)
  const { port, responders } = await noiseServer(t, crypto.keyPair())
  const ws = new WebSocket('ws://127.0.0.1:' + port)
  let limited = 0
  const { ws: inner, stream } = guardedWsStream(ws, { maxFrame: 65536, onLimit: () => limited++ })
  const noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await connected(noise)
  await until(() => responders.length === 1, { name: 'responder' })
  const responder = responders[0]
  // It may have connected already: wait on its opened promise, not 'connect'.
  t.is(await responder.noise.opened, true, 'responder connected')
  const payload = b4a.alloc(4096, 7)
  const got = new Promise((resolve) => {
    const chunks = []
    let total = 0
    noise.on('data', (chunk) => {
      chunks.push(chunk)
      total += chunk.byteLength
      if (total >= payload.byteLength) resolve(b4a.concat(chunks))
    })
  })
  responder.noise.write(payload)
  t.ok(b4a.equals(await got, payload), '4 KiB frame forwarded intact')
  t.is(limited, 0, 'no limit hit')
  t.is(inner.closeCode, null, 'no close code while open')
  noise.destroy()
  await closed(responder.noise)
  await until(() => ws.readyState === WebSocket.CLOSED, { name: 'socket fechado' })
})

test('wsStream records the close code without changing how it ends', async (t) => {
  await testnet(t)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => new Promise((resolve) => wss.close(() => resolve())), { force: true })
  wss.on('connection', (ws) => ws.close(1013, 'lotado'))
  const ws = new WebSocket('ws://127.0.0.1:' + wss.address().port)
  ws.on('error', () => {})
  const duplex = wsStream(ws)
  duplex.on('error', () => {})
  await closed(duplex)
  t.ok(duplex.destroyed, 'destroyed by the socket close')
  t.is(duplex.closeCode, 1013, 'close code kept')
})
