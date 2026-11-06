'use strict'

// The anonymous blob channel 'varanda/blob/1' (docs/protocol.md section 13)
// on the protomux that the replication stream put in
// socket.noiseStream.userData, as lib/dm-net.js. A member puts stamped,
// encrypted chunks (lib/blob.js) into the seeder's blob pool; nothing on this
// channel names a diary: no challenge, no proof, no key. The member opens it
// on its own link with a fresh Noise key, so the seeder cannot tie a chunk to
// a member.
//
// Flow (all messages JSON in one c.buffer message type):
//   member -> seeder  { type: 'put', chunk }           chunk: base64, BLOB_FRAME_BYTES
//   seeder -> member  { type: 'ack', ok, reason }      reason: null | 'cheio' | 'invalido' | 'ritmo'
// One put in flight per socket, not per channel: a second put while one is
// unanswered is a bad message, also on a channel the member reopened while
// the first put was still running. A put that settles after its channel
// closed answers nothing (never on a newer channel); one that throws closes
// the channel it came on, a no-op once that channel is gone.
//
// Bad messages: a frame over maxBytes, a JSON or shape failure, a chunk that
// is not the canonical base64 of BLOB_FRAME_BYTES bytes (a truncated frame
// included), a put while one is unanswered, an unsolicited reply, and any
// message of the other role. More than maxBad of them drops the peer
// (socket.destroy()). Every message takes a token of the channel bucket
// before parsing (out of tokens drops the peer with 'message-rate'); a put
// over its own budget is answered 'ritmo' and stored nowhere. A full-size
// frame the pool refuses (bad magic, a token that does not match, a bad or
// spent stamp, a mismatched repeat) is answered 'invalido'.
//
// A seeder whose put() throws closes the channel instead of answering: the
// member sees a failure, never a false 'ok'. A member never repeats a put by
// itself: a put whose ack does not arrive is uncertain, and only the user may
// send it again (the pool answers an identical frame as a repeated success).
//
// Logs carry a fixed event and reason only, never an id, a key or an address.
const b4a = require('b4a')
const c = require('compact-encoding')
const clock = require('./clock')
const { hasExactKeys } = require('./records')
const { BLOB_PROTOCOL, BLOB_FRAME_BYTES, BLOB_MAX_MESSAGE } = require('./blob')

const MAX_BAD_BLOB = 5
const BLOB_REQUEST_TIMEOUT_MS = 15000
const BLOB_MESSAGE_BURST = 64
const BLOB_MESSAGE_RATE = 24 // tokens per second
const BLOB_PUT_BURST = 32
const BLOB_PUT_RATE = 8 // chunks per second
const ACK_REASONS = Object.freeze([null, 'cheio', 'invalido', 'ritmo'])
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const FRAME_BASE64_LENGTH = Math.ceil(BLOB_FRAME_BYTES / 3) * 4

function noop () {}

function tokenBucket (burst, rate) {
  let tokens = burst
  let last = clock.now()
  return {
    take () {
      const now = clock.now()
      tokens = Math.min(burst, tokens + (now - last) * rate / 1000)
      last = now
      if (tokens < 1) return false
      tokens--
      return true
    }
  }
}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function isFrameBase64 (s) {
  if (typeof s !== 'string' || s.length !== FRAME_BASE64_LENGTH || !BASE64.test(s)) return false
  const bytes = b4a.from(s, 'base64')
  return bytes.byteLength === BLOB_FRAME_BYTES && b4a.toString(bytes, 'base64') === s
}

// Exact keys for every message of the channel. Never throws.
function validateBlobMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'put':
        return hasExactKeys(msg, ['type', 'chunk']) && isFrameBase64(msg.chunk)
      case 'ack':
        if (!hasExactKeys(msg, ['type', 'ok', 'reason']) || typeof msg.ok !== 'boolean') return false
        if (!ACK_REASONS.includes(msg.reason)) return false
        return msg.ok ? msg.reason === null : msg.reason !== null
      default:
        return false
    }
  } catch {
    return false
  }
}

// The ack for a pool submit() result: { ok: true, ... } is success, 'cheio'
// is a full pool, anything else is a refused chunk.
function ackFor (result) {
  if (result === 'cheio') return { type: 'ack', ok: false, reason: 'cheio' }
  if (isPlainObject(result) && result.ok === true) return { type: 'ack', ok: true, reason: null }
  return { type: 'ack', ok: false, reason: 'invalido' }
}

function attachBlob (socket, opts = {}) {
  const slot = opts.slot === undefined ? '_varandaBlob' : opts.slot
  if (typeof slot !== 'string' || slot === '') throw new TypeError('invalid slot')
  if (socket && socket[slot]) return socket[slot]

  const {
    role,
    put,
    log = noop,
    maxBytes = BLOB_MAX_MESSAGE,
    maxBad = MAX_BAD_BLOB,
    requestTimeoutMs = BLOB_REQUEST_TIMEOUT_MS,
    messageBurst = BLOB_MESSAGE_BURST,
    messageRate = BLOB_MESSAGE_RATE,
    putBurst = BLOB_PUT_BURST,
    putRate = BLOB_PUT_RATE
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder' && typeof put !== 'function') throw new TypeError('put must be a function')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!(requestTimeoutMs > 0)) throw new TypeError('invalid requestTimeoutMs')
  for (const [burst, rate] of [[messageBurst, messageRate], [putBurst, putRate]]) {
    if (!(burst >= 1) || !(rate > 0)) throw new TypeError('invalid rate limits')
  }

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachBlob')

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  const inbound = tokenBucket(messageBurst, messageRate)
  const puts = tokenBucket(putBurst, putRate)

  // Seeder: whether a put is being answered, for the socket's lifetime, so a
  // reopened channel cannot start a second one. Member: the put being waited for.
  let answering = false
  let request = null

  const handle = {
    socket,
    role,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') handle.put = memberPut
  socket[slot] = handle

  mux.pair({ protocol: BLOB_PROTOCOL }, onpair)
  openChannel()
  if (typeof socket.once === 'function') socket.once('close', end)

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol: BLOB_PROTOCOL, onopen, onclose: onchannelclose })
    if (ch === null) return
    channel = ch
    message = ch.addMessage({ encoding: c.buffer, onmessage: onraw })
    ch.open()
  }

  function onpair () {
    if (ended || dropped || channel !== null) return
    openChannel()
  }

  function onopen (handshake, ch) {
    if (ch !== channel || ended) return
    isOpen = true
    settle(true)
    if (request !== null && !request.sent) sendRequest()
  }

  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    failRequest(new Error('blob channel closed'))
    if (!wasOpen) settle(false)
    if (role === 'member') end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol: BLOB_PROTOCOL })
    failRequest(new Error('blob channel closed'))
    settle(false)
    if (socket[slot] === handle) delete socket[slot]
    if (typeof socket.off === 'function') socket.off('close', end)
  }

  function close () {
    const ch = channel
    end()
    if (ch !== null) ch.close()
  }

  function rawSend (msg) {
    if (!isOpen || message === null) return false
    message.send(b4a.from(JSON.stringify(msg), 'utf8'))
    return true
  }

  function drop (reason) {
    if (dropped || ended) return
    dropped = true
    failRequest(new Error('blob peer dropped'))
    log({ event: 'peer-dropped', reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop('blob')
  }

  function onraw (buf) {
    if (ended || dropped) return
    if (!inbound.take()) {
      drop('message-rate')
      return
    }
    let msg
    try {
      if (!buf || buf.byteLength === 0 || buf.byteLength > maxBytes) {
        badMessage()
        return
      }
      msg = JSON.parse(b4a.toString(buf, 'utf8'))
    } catch {
      badMessage()
      return
    }
    if (!validateBlobMessage(msg)) {
      badMessage()
      return
    }
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (msg.type !== 'put' || answering) {
      badMessage()
      return
    }
    if (!puts.take()) {
      rawSend({ type: 'ack', ok: false, reason: 'ritmo' })
      return
    }
    answerPut(msg)
  }

  // Not awaited by protomux: a rejected promise there destroys the stream.
  async function answerPut (msg) {
    answering = true
    const ch = channel
    let reply = null
    try {
      reply = ackFor(await put(b4a.from(msg.chunk, 'base64')))
    } catch {
      log({ event: 'blob-put-failed', reason: 'erro' })
    }
    answering = false
    if (reply === null) {
      if (ch !== null) ch.close()
      return
    }
    if (ch !== channel || ended || dropped) return
    rawSend(reply)
  }

  // ---- member role ----

  function onmember (msg) {
    const r = request
    if (r === null || !r.sent || msg.type !== 'ack') {
      badMessage()
      return
    }
    request = null
    clearTimeout(r.timer)
    r.resolve({ ok: msg.ok, reason: msg.reason })
  }

  // The timeout runs from the call and is terminal: it rejects AND closes
  // the channel (the socket stays), so a late ack cannot answer a later put.
  function memberPut (bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BLOB_FRAME_BYTES) {
      return Promise.reject(new TypeError('chunk must be ' + BLOB_FRAME_BYTES + ' bytes'))
    }
    if (ended || dropped) return Promise.reject(new Error('blob channel closed'))
    if (request !== null) return Promise.reject(new Error('a blob put is already in flight'))
    const msg = { type: 'put', chunk: b4a.toString(bytes, 'base64') }
    return new Promise((resolve, reject) => {
      const r = { msg, sent: false, resolve, reject, timer: null }
      r.timer = setTimeout(() => {
        if (request !== r) return
        request = null
        reject(new Error('blob request timed out'))
        close()
      }, requestTimeoutMs)
      request = r
      if (isOpen) sendRequest()
    })
  }

  function sendRequest () {
    const r = request
    if (r === null || r.sent) return
    if (!rawSend(r.msg)) return
    r.sent = true
  }

  function failRequest (err) {
    const r = request
    if (r === null) return
    request = null
    clearTimeout(r.timer)
    r.reject(err)
  }
}

module.exports = {
  BLOB_PROTOCOL,
  MAX_BAD_BLOB,
  BLOB_REQUEST_TIMEOUT_MS,
  BLOB_MESSAGE_BURST,
  BLOB_MESSAGE_RATE,
  BLOB_PUT_BURST,
  BLOB_PUT_RATE,
  validateBlobMessage,
  attachBlob
}
