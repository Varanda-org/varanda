// lib/duplex-socket.js over a fake of bare-ws's client socket (a streamx
// Duplex that emits 'open' after its handshake, 'message'(payload, binary)
// for every message, exposes closeCode and closes with close(code)): event
// order, send before open, close code propagation, text frames, and
// wsStream exchanging binary chunks through a linked pair.
const test = require('brittle')
const { Duplex } = require('streamx')
const b4a = require('b4a')
const { duplexSocket, CONNECTING, OPEN, CLOSING, CLOSED } = require('../lib/duplex-socket')
const { wsStream } = require('../lib/ws-stream')

const ABNORMAL = 1006
const NO_STATUS = 1005

class FakeWs extends Duplex {
  constructor () {
    super({ eagerOpen: true })
    this.peer = null
    this.sent = []
    this._closeCode = ABNORMAL
    this._localCode = null
    this._pendingOpen = null
    this._connected = false
  }

  get closeCode () {
    return this._closeCode
  }

  // The handshake finishing.
  connect () {
    this._connected = true
    const cb = this._pendingOpen
    this._pendingOpen = null
    if (cb) cb(null)
  }

  _open (cb) {
    if (this._connected) cb(null)
    else this._pendingOpen = cb
  }

  // A message from the peer, the way bare-ws surfaces it.
  receive (payload, binary) {
    this.emit('message', payload, binary)
    this.push(payload)
  }

  // A close frame from the peer, echoed back as RFC 6455 asks.
  receiveClose (code) {
    this._closeCode = code === null ? NO_STATUS : code
    if (this._localCode === null) this._localCode = code
    this.push(null)
    this.end()
  }

  close (code = 1000) {
    this._localCode = code
    this.end()
  }

  _write (data, cb) {
    this.sent.push(data)
    if (this.peer) this.peer.receive(data, true)
    cb(null)
  }

  _final (cb) {
    if (this.peer && !this.peer.destroying) this.peer.receiveClose(this._localCode)
    cb(null)
  }
}

function pair () {
  const a = new FakeWs()
  const b = new FakeWs()
  a.peer = b
  b.peer = a
  return { a, b }
}

function record (socket) {
  const events = []
  socket.addEventListener('open', () => events.push(['open', socket.readyState]))
  socket.addEventListener('message', (e) => events.push(['message', e.data]))
  socket.addEventListener('close', (e) => events.push(['close', e.code, socket.readyState]))
  socket.addEventListener('error', (e) => events.push(['error', e.type]))
  return events
}

function once (emitter, name) {
  return new Promise((resolve) => emitter.once(name, resolve))
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('readyState and event order: open, message, close', async (t) => {
  const { a, b } = pair()
  const sa = duplexSocket(a)
  duplexSocket(b)
  const events = record(sa)
  t.is(sa.readyState, CONNECTING)
  t.is(sa.binaryType, 'arraybuffer')
  sa.binaryType = 'blob'
  t.is(sa.binaryType, 'blob', 'binaryType is settable')

  a.connect()
  b.connect()
  await once(a, 'open')
  t.is(sa.readyState, OPEN)

  b.write(b4a.from([1, 2, 3]))
  await tick()
  sa.close(4000)
  t.is(sa.readyState, CLOSING)
  await once(a, 'close')

  t.is(events.length, 3)
  t.alike(events[0], ['open', OPEN])
  t.is(events[1][0], 'message')
  t.ok(events[1][1] instanceof ArrayBuffer, 'binary frame is an ArrayBuffer')
  t.alike(Array.from(new Uint8Array(events[1][1])), [1, 2, 3])
  t.alike(events[2], ['close', 4000, CLOSED], 'the echoed code reaches close listeners')
  t.is(b.closeCode, 4000, 'the peer saw the close code sent')
})

test('send before open throws, after close throws', async (t) => {
  const { a, b } = pair()
  const sa = duplexSocket(a)
  duplexSocket(b)
  t.exception.all(() => sa.send(new Uint8Array(1)), /não está aberto/)
  a.connect()
  b.connect()
  await once(a, 'open')
  sa.send(new Uint8Array([9]))
  await tick()
  t.is(a.sent.length, 1)
  t.ok(b4a.isBuffer(a.sent[0]), 'written as a Buffer (binary for bare-ws)')
  sa.close()
  t.exception.all(() => sa.send(new Uint8Array(1)), /não está aberto/)
})

test('send writes exactly the view, not the whole backing buffer', async (t) => {
  const { a, b } = pair()
  const sa = duplexSocket(a)
  duplexSocket(b)
  a.connect()
  b.connect()
  await once(a, 'open')
  const backing = new Uint8Array([0, 1, 2, 3, 4, 5])
  sa.send(backing.subarray(2, 4))
  await tick()
  t.alike(Array.from(a.sent[0]), [2, 3])
})

test('close code: the peer\'s code propagates to close listeners', async (t) => {
  const { a, b } = pair()
  const sa = duplexSocket(a)
  const sb = duplexSocket(b)
  const events = record(sa)
  a.connect()
  b.connect()
  await once(a, 'open')
  sb.close(1013)
  await once(a, 'close')
  t.alike(events.at(-1), ['close', 1013, CLOSED])
})

test('close code: an error closes with the duplex code (1006), error first', async (t) => {
  const a = new FakeWs()
  const sa = duplexSocket(a)
  const events = record(sa)
  a.connect()
  await once(a, 'open')
  a.destroy(new Error('connection reset'))
  await once(a, 'close')
  t.alike(events.slice(1), [['error', 'error'], ['close', ABNORMAL, CLOSED]])
})

test('close code: without closeCode, 1006 on error and 1000 on a clean end', async (t) => {
  const plain = () => {
    const d = new Duplex({ read (cb) { cb(null) }, write (data, cb) { cb(null) } })
    return d
  }
  const d1 = plain()
  const s1 = duplexSocket(d1)
  const e1 = record(s1)
  d1.destroy(new Error('boom'))
  await once(d1, 'close')
  t.alike(e1.at(-1), ['close', 1006, CLOSED])

  const d2 = plain()
  const s2 = duplexSocket(d2)
  const e2 = record(s2)
  d2.destroy()
  await once(d2, 'close')
  t.alike(e2, [['close', 1000, CLOSED]])
})

test('a text frame surfaces as a string and makes wsStream destroy', async (t) => {
  const a = new FakeWs()
  const sa = duplexSocket(a)
  const events = record(sa)
  a.connect()
  await once(a, 'open')
  a.receive(b4a.from('olá', 'utf8'), false)
  t.alike(events.at(-1), ['message', 'olá'])

  const c = new FakeWs()
  const stream = wsStream(duplexSocket(c))
  stream.on('error', () => {})
  c.connect()
  await once(c, 'open')
  const closed = once(stream, 'close')
  c.receive(b4a.from('texto'), false)
  await closed
  t.ok(stream.destroyed, 'wsStream destroyed on a text frame')
  await tick()
  t.is(c._localCode, 1000, 'and closed the socket with 1000')
})

test('wsStream over duplexSocket exchanges binary chunks both ways', async (t) => {
  const { a, b } = pair()
  const left = wsStream(duplexSocket(a))
  const right = wsStream(duplexSocket(b))
  left.on('error', () => {})
  right.on('error', () => {})

  // Written while CONNECTING: wsStream buffers until 'open'.
  left.write(b4a.from('early'))
  a.connect()
  b.connect()

  const gotRight = []
  const gotLeft = []
  right.on('data', (c) => gotRight.push(b4a.toString(c)))
  left.on('data', (c) => gotLeft.push(b4a.toString(c)))

  await once(a, 'open')
  left.write(b4a.from('ping'))
  right.write(b4a.from('pong'))
  const big = b4a.alloc(65536, 7)
  right.write(big)
  await new Promise((resolve) => {
    const check = () => gotRight.length >= 2 && gotLeft.length >= 2 ? resolve() : setImmediate(check)
    check()
  })
  t.alike(gotRight, ['early', 'ping'])
  t.is(gotLeft[0], 'pong')
  t.is(gotLeft[1].length, 65536)

  const rightClosed = once(right, 'close')
  left.destroy()
  await rightClosed
  t.is(right.closeCode, 1000, 'closing one side closes the other with 1000')
})

test('send copies the bytes: reusing the source after send changes nothing', async (t) => {
  const { a, b } = pair()
  const sa = duplexSocket(a)
  const sb = duplexSocket(b)
  const got = []
  sb.addEventListener('message', (e) => got.push(Array.from(new Uint8Array(e.data))))
  a.connect()
  b.connect()
  await once(a, 'open')
  const source = new Uint8Array([1, 2, 3])
  sa.send(source)
  source.fill(0)
  await tick()
  t.alike(got, [[1, 2, 3]], 'the peer received the bytes as they were at send()')
})

test('close while CONNECTING fails the connection at once', async (t) => {
  const a = new FakeWs() // never connected: its open stays pending
  const sa = duplexSocket(a)
  const events = record(sa)
  const closed = once(a, 'close')
  sa.close()
  t.ok(a.destroying, 'the duplex is destroyed, not ended')
  await closed
  t.is(sa.readyState, CLOSED)
  t.alike(events, [['close', 1006, CLOSED]])
  t.is(a._localCode, null, 'no graceful close was attempted')
  a.connect() // a handshake finishing late changes nothing
  await tick()
  t.is(sa.readyState, CLOSED)
  t.is(events.length, 1)
})
