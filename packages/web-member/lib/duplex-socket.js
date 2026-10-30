'use strict'
// A WebSocket-like facade over a streamx Duplex WebSocket client (bare-ws's
// Socket in the Bare worklet), so lib/ws-stream drives it exactly as it
// drives the browser WebSocket or Node's ws: binaryType, readyState,
// add/removeEventListener('open'|'message'|'close'|'error'), send(), close().
// No bare-* import: the worklet builds the bare-ws socket and passes it in.
//
// What the duplex is expected to do (bare-ws 3.2.0): emit 'open' once the
// handshake is through (streamx, after _open), emit 'message'(payload,
// binary) for every complete message and also push it on its readable side,
// expose the peer's close code as `closeCode`, take close(code) or end() to
// close, and emit 'error' then 'close' when it is destroyed.
// The readable side is drained and discarded here: messages arrive through
// 'message', and an unread readable would fill up and pause the socket.

const b4a = require('b4a')

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

const NORMAL_CLOSURE = 1000
const ABNORMAL_CLOSURE = 1006

const EVENTS = ['open', 'message', 'close', 'error']

class DuplexSocket {
  constructor (duplex) {
    this.duplex = duplex
    this.binaryType = 'arraybuffer'
    this.readyState = CONNECTING
    this._listeners = new Map(EVENTS.map((name) => [name, new Set()]))
    this._errored = false
    this._cancelled = false // close() while CONNECTING
    this._closed = false // 'close' dispatched

    this._onopen = () => {
      if (this.readyState !== CONNECTING) return
      this.readyState = OPEN
      this._dispatch('open', { type: 'open' })
    }
    this._onmessage = (payload, binary) => this._onMessage(payload, binary)
    this._ondata = () => {}
    // streamx follows every error with 'close', which ws-stream waits for.
    this._onerror = (err) => {
      if (this._closed || this._errored) return
      this._errored = true
      this.readyState = CLOSED
      this._dispatch('error', { type: 'error', error: err })
    }
    this._onclose = () => {
      if (this._closed) return
      this._closed = true
      this.readyState = CLOSED
      this._detach()
      this._dispatch('close', { type: 'close', code: this._closeCode() })
    }

    duplex.on('open', this._onopen)
    duplex.on('message', this._onmessage)
    duplex.on('data', this._ondata)
    duplex.on('error', this._onerror)
    duplex.on('close', this._onclose)
  }

  addEventListener (name, fn) {
    const set = this._listeners.get(name)
    if (set && typeof fn === 'function') set.add(fn)
  }

  removeEventListener (name, fn) {
    const set = this._listeners.get(name)
    if (set) set.delete(fn)
  }

  send (bytes) {
    if (this.readyState !== OPEN) throw new Error('o soquete não está aberto')
    if (!ArrayBuffer.isView(bytes)) throw new TypeError('só bytes podem ser enviados')
    // Copied now, as a browser does: streamx frames the write on a later
    // tick and the caller may reuse its buffer. A Buffer, because bare-ws
    // frames a Buffer write as binary (a string would go out as text).
    const copy = b4a.alloc(bytes.byteLength)
    copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    this.duplex.write(copy)
  }

  close (code = NORMAL_CLOSURE) {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return
    const duplex = this.duplex
    // Closing while CONNECTING fails the connection, as in a browser:
    // bare-ws's end() would wait for the handshake (up to its timeout).
    if (this.readyState === CONNECTING) {
      this._cancelled = true
      this.readyState = CLOSING
      duplex.destroy()
      return
    }
    this.readyState = CLOSING
    try {
      if (typeof duplex.close === 'function') duplex.close(code)
      else duplex.end()
    } catch {
      // An invalid close code (bare-ws refuses reserved ones): close plainly.
      try {
        duplex.end()
      } catch {
        duplex.destroy()
      }
    }
  }

  _onMessage (payload, binary) {
    if (this._closed) return
    let data
    if (binary === false) {
      data = typeof payload === 'string' ? payload : b4a.toString(b4a.from(payload.buffer, payload.byteOffset, payload.byteLength), 'utf8')
    } else if (payload instanceof ArrayBuffer) {
      data = payload.slice(0)
    } else {
      data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    }
    this._dispatch('message', { type: 'message', data })
  }

  // A cancelled connection is an abnormal closure; otherwise the peer's code
  // when the duplex exposes one, else what the way it ended says: an error
  // is an abnormal closure, a clean end a normal one.
  _closeCode () {
    if (this._cancelled) return ABNORMAL_CLOSURE
    const code = this.duplex.closeCode
    if (Number.isInteger(code)) return code
    return this._errored ? ABNORMAL_CLOSURE : NORMAL_CLOSURE
  }

  _dispatch (name, event) {
    for (const fn of [...this._listeners.get(name)]) {
      try {
        fn(event)
      } catch {}
    }
  }

  // The 'error' listener stays: a streamx error without one would throw.
  _detach () {
    const duplex = this.duplex
    duplex.removeListener('open', this._onopen)
    duplex.removeListener('message', this._onmessage)
    duplex.removeListener('data', this._ondata)
    duplex.removeListener('close', this._onclose)
  }
}

function duplexSocket (duplex) {
  return new DuplexSocket(duplex)
}

module.exports = { duplexSocket, DuplexSocket, CONNECTING, OPEN, CLOSING, CLOSED }
