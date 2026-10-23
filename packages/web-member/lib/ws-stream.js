// A streamx Duplex over a WebSocket-like object: the browser WebSocket or
// Node's `ws` client/server socket, both driven only through
// addEventListener/removeEventListener, readyState, send() and close(), so
// the same code runs in both without environment detection.
// One binary frame is one chunk and chunks carry no length prefix: the Noise
// secret stream layered on top frames its own bytes (3-byte little-endian
// lengths), so frame boundaries do not matter to it. A text frame is a
// protocol violation and destroys the stream. Writes made while the socket is
// still CONNECTING are buffered and flushed on 'open'. Destroying the stream
// closes the socket (code 1000); the socket closing destroys the stream; a
// socket error is ignored here because every error is followed by 'close'.
// Known limit: bufferedAmount is not consulted (no write backpressure).
const { Duplex } = require('streamx')
const b4a = require('b4a')

const CONNECTING = 0
const OPEN = 1

class WebSocketStream extends Duplex {
  constructor (socket) {
    super()
    this.socket = socket
    this._pending = [] // chunks written while CONNECTING
    this._onopen = () => this._flushPending()
    this._onmessage = (event) => this._onMessage(event)
    this._onclose = () => this.destroy()
    this._onerror = () => {}
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', this._onopen)
    socket.addEventListener('message', this._onmessage)
    socket.addEventListener('close', this._onclose)
    socket.addEventListener('error', this._onerror)
    if (socket.readyState !== CONNECTING) this._pending = null
  }

  _onMessage (event) {
    if (this.destroying) return
    const data = event.data
    if (typeof data === 'string') {
      this.destroy(new Error('quadro de texto recebido no transporte binário'))
      return
    }
    let chunk
    if (data instanceof ArrayBuffer) chunk = b4a.from(new Uint8Array(data))
    else if (ArrayBuffer.isView(data)) chunk = b4a.from(data.buffer, data.byteOffset, data.byteLength)
    else {
      this.destroy(new Error('quadro desconhecido recebido no transporte'))
      return
    }
    this.push(chunk)
  }

  _flushPending () {
    const pending = this._pending
    this._pending = null
    if (pending === null || this.destroying) return
    for (const chunk of pending) this._send(chunk)
  }

  _send (chunk) {
    if (this.socket.readyState !== OPEN) return
    const bytes = chunk instanceof Uint8Array ? chunk : b4a.from(chunk)
    this.socket.send(bytes)
  }

  _write (chunk, cb) {
    if (this._pending !== null && this.socket.readyState === CONNECTING) this._pending.push(chunk)
    else this._send(chunk)
    cb(null)
  }

  _read (cb) {
    cb(null)
  }

  // A WebSocket has no half-close: ending the writable side closes it.
  _final (cb) {
    this._closeSocket()
    cb(null)
  }

  _predestroy () {
    this._pending = null
    this._flushQueued()
    this._closeSocket()
  }

  // streamx hands chunks to _write on a later tick, so bytes written right
  // before destroy() (the Noise initiator's final handshake message, say)
  // would never reach the socket: send what is still queued, in order,
  // before the socket closes. Uses streamx's _writableState queue (a FIFO
  // with isEmpty/shift) on purpose; there is no public hook for this.
  _flushQueued () {
    const state = this._writableState
    if (!state || !state.queue || this.socket.readyState !== OPEN) return
    while (!state.queue.isEmpty()) this._send(state.shift())
  }

  _destroy (cb) {
    const socket = this.socket
    socket.removeEventListener('open', this._onopen)
    socket.removeEventListener('message', this._onmessage)
    socket.removeEventListener('close', this._onclose)
    // The error listener stays: Node's ws emits 'error' on its emitter and
    // an unlistened error would throw.
    cb(null)
  }

  _closeSocket () {
    const state = this.socket.readyState
    if (state !== CONNECTING && state !== OPEN) return
    try {
      this.socket.close(1000)
    } catch {}
  }
}

function wsStream (socket) {
  return new WebSocketStream(socket)
}

module.exports = { wsStream, WebSocketStream }
