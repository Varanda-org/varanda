'use strict'

// The anonymous direct message channel 'varanda/dm/1' (docs/protocol.md
// section 11) on the protomux that the replication stream put in
// socket.noiseStream.userData, as notices-net.js. A member drops sealed,
// stamped frames into the seeder's pool and pages through the pool; nothing
// on this channel names a diary: no challenge, no proof, no key. The member
// opens it on its own link with a fresh Noise key, so the seeder cannot tie a
// drop or a pull to a member.
//
// Flow (all messages JSON in one c.buffer message type):
//   member -> seeder  { type: 'put', drop }            drop: base64, DM_DROP_BYTES
//   seeder -> member  { type: 'ack', ok, reason }      reason: null | 'cheio' | 'invalido' | 'ritmo'
//   member -> seeder  { type: 'page', after, limit }   after: seq cursor, exclusive
//   seeder -> member  { type: 'items', items, next, oldest }
// One request in flight per channel: a second put or page while one is
// unanswered is a bad message.
//
// Bad messages: a frame over maxBytes, a JSON or shape failure, a drop that
// is not the canonical base64 of DM_DROP_BYTES bytes, a request while one is
// unanswered, an unsolicited reply, and any message of the other role. More
// than maxBad of them drops the peer (socket.destroy()). Rates: every message
// takes a token of the channel bucket before parsing (out of tokens drops the
// peer with 'message-rate'); a page takes one of the page bucket (a full pull
// is many pages, so it is generous; out of tokens drops with 'dm-page-rate');
// a put over its own budget is answered 'ritmo' and stored nowhere.
//
// A seeder whose put() or page() throws closes the channel instead of
// answering: the member sees a failure, never a false 'ok' or a false end of
// the pool. A member never repeats a put by itself: a put whose ack does not
// arrive is uncertain, and only the user may send it again (the pool answers
// an identical drop as a repeated success).
//
// Lifetime: as notices-net.js. A member handle is single-use per channel;
// a request timeout is terminal for the channel, never the socket.
const b4a = require('b4a')
const c = require('compact-encoding')
const clock = require('./clock')
const { hasExactKeys } = require('./records')
const { DM_PROTOCOL, DM_DROP_BYTES, DM_PAGE_MAX, DM_MAX_MESSAGE } = require('./dm')

const MAX_BAD_DM = 5
const DM_REQUEST_TIMEOUT_MS = 10000
const DM_MESSAGE_BURST = 64
const DM_MESSAGE_RATE = 24 // tokens per second
const DM_PAGE_BURST = 40
const DM_PAGE_RATE = 20
const DM_PUT_BURST = 8
const DM_PUT_RATE = 8 / 60
const ACK_REASONS = Object.freeze([null, 'cheio', 'invalido', 'ritmo'])
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const DROP_BASE64_LENGTH = Math.ceil(DM_DROP_BYTES / 3) * 4

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

function isCursor (n) {
  return Number.isSafeInteger(n) && n >= 0
}

function isSeq (n) {
  return Number.isSafeInteger(n) && n >= 1
}

function isDropBase64 (s) {
  if (typeof s !== 'string' || s.length !== DROP_BASE64_LENGTH || !BASE64.test(s)) return false
  const bytes = b4a.from(s, 'base64')
  return bytes.byteLength === DM_DROP_BYTES && b4a.toString(bytes, 'base64') === s
}

function validItems (items) {
  if (!Array.isArray(items) || items.length > DM_PAGE_MAX) return false
  let prev = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!isPlainObject(it) || !hasExactKeys(it, ['seq', 'drop'])) return false
    if (!isSeq(it.seq) || it.seq <= prev || !isDropBase64(it.drop)) return false
    prev = it.seq
  }
  return true
}

// Exact keys for every message of the channel. Never throws.
function validateDmMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'put':
        return hasExactKeys(msg, ['type', 'drop']) && isDropBase64(msg.drop)
      case 'page':
        return hasExactKeys(msg, ['type', 'after', 'limit']) && isCursor(msg.after) &&
          Number.isSafeInteger(msg.limit) && msg.limit >= 1 && msg.limit <= DM_PAGE_MAX
      case 'ack':
        if (!hasExactKeys(msg, ['type', 'ok', 'reason']) || typeof msg.ok !== 'boolean') return false
        if (!ACK_REASONS.includes(msg.reason)) return false
        return msg.ok ? msg.reason === null : msg.reason !== null
      case 'items':
        return hasExactKeys(msg, ['type', 'items', 'next', 'oldest']) && validItems(msg.items) &&
          (msg.next === null || isCursor(msg.next)) && isCursor(msg.oldest)
      default:
        return false
    }
  } catch {
    return false
  }
}

// The ack for a pool submit() result: { seq } and { seq, repeated } are
// success, 'cheio' is a full pool, anything else is a refused drop.
function ackFor (result) {
  if (result === 'cheio') return { type: 'ack', ok: false, reason: 'cheio' }
  if (isPlainObject(result) && isSeq(result.seq)) return { type: 'ack', ok: true, reason: null }
  return { type: 'ack', ok: false, reason: 'invalido' }
}

// Our items message from a pool page() result, trimmed from the end until it
// fits maxBytes, or null when the result is not a page.
function itemsMessage (result, after, limit, maxBytes) {
  if (!isPlainObject(result) || !Array.isArray(result.items) || !isCursor(result.oldest)) return null
  if (result.next !== null && result.next !== undefined && !isCursor(result.next)) return null
  const items = []
  for (const it of result.items.slice(0, limit)) {
    if (!isPlainObject(it) || !isSeq(it.seq) || it.seq <= after) return null
    if (!(it.bytes instanceof Uint8Array) || it.bytes.byteLength !== DM_DROP_BYTES) return null
    items.push({ seq: it.seq, drop: b4a.toString(it.bytes, 'base64') })
  }
  let next = result.next === undefined ? null : result.next
  if (result.items.length > items.length && items.length > 0) next = items[items.length - 1].seq
  for (;;) {
    const msg = { type: 'items', items, next, oldest: result.oldest }
    if (!validateDmMessage(msg)) return null
    if (b4a.byteLength(JSON.stringify(msg)) <= maxBytes) return msg
    if (items.length <= 1) return null
    items.pop()
    next = items[items.length - 1].seq
  }
}

function attachDm (socket, opts = {}) {
  const slot = opts.slot === undefined ? '_varandaDm' : opts.slot
  if (typeof slot !== 'string' || slot === '') throw new TypeError('invalid slot')
  if (socket && socket[slot]) return socket[slot]

  const {
    role,
    put,
    page,
    log = noop,
    maxBytes = DM_MAX_MESSAGE,
    maxBad = MAX_BAD_DM,
    requestTimeoutMs = DM_REQUEST_TIMEOUT_MS,
    messageBurst = DM_MESSAGE_BURST,
    messageRate = DM_MESSAGE_RATE,
    pageBurst = DM_PAGE_BURST,
    pageRate = DM_PAGE_RATE,
    putBurst = DM_PUT_BURST,
    putRate = DM_PUT_RATE
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder' && (typeof put !== 'function' || typeof page !== 'function')) {
    throw new TypeError('put and page must be functions')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!(requestTimeoutMs > 0)) throw new TypeError('invalid requestTimeoutMs')
  for (const [burst, rate] of [[messageBurst, messageRate], [pageBurst, pageRate], [putBurst, putRate]]) {
    if (!(burst >= 1) || !(rate > 0)) throw new TypeError('invalid rate limits')
  }

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachDm')

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  const inbound = tokenBucket(messageBurst, messageRate)
  const pages = tokenBucket(pageBurst, pageRate)
  const puts = tokenBucket(putBurst, putRate)

  // Seeder: whether a request is being answered. Member: the request being
  // waited for, with the reply type it expects.
  let answering = false
  let request = null

  const handle = {
    socket,
    role,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') {
    handle.put = memberPut
    handle.requestPage = requestPage
  }
  socket[slot] = handle

  mux.pair({ protocol: DM_PROTOCOL }, onpair)
  openChannel()
  if (typeof socket.once === 'function') socket.once('close', end)

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol: DM_PROTOCOL, onopen, onclose: onchannelclose })
    if (ch === null) return
    channel = ch
    answering = false
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
    failRequest(new Error('dm channel closed'))
    if (!wasOpen) settle(false)
    if (role === 'member') end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol: DM_PROTOCOL })
    failRequest(new Error('dm channel closed'))
    settle(false)
    if (socket[slot] === handle) delete socket[slot]
    if (typeof socket.off === 'function') socket.off('close', end)
  }

  function close () {
    const ch = channel
    end()
    if (ch !== null) ch.close()
  }

  function closeChannel () {
    const ch = channel
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
    failRequest(new Error('dm peer dropped'))
    log({ event: 'peer-dropped', reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop('dm')
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
    if (!validateDmMessage(msg)) {
      badMessage()
      return
    }
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (msg.type !== 'put' && msg.type !== 'page') {
      badMessage()
      return
    }
    if (answering) {
      badMessage()
      return
    }
    if (msg.type === 'page') {
      if (!pages.take()) {
        drop('dm-page-rate')
        return
      }
      answerPage(msg)
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
      reply = ackFor(await put(b4a.from(msg.drop, 'base64')))
    } catch {
      log({ event: 'dm-put-failed', reason: 'erro' })
    }
    if (ch !== channel || ended || dropped) return
    answering = false
    if (reply === null) closeChannel()
    else rawSend(reply)
  }

  async function answerPage (msg) {
    answering = true
    const ch = channel
    let reply = null
    try {
      reply = itemsMessage(await page({ after: msg.after, limit: msg.limit }), msg.after, msg.limit, maxBytes)
      if (reply === null) log({ event: 'dm-page-invalid' })
    } catch {
      log({ event: 'dm-page-failed', reason: 'erro' })
    }
    if (ch !== channel || ended || dropped) return
    answering = false
    if (reply === null) closeChannel()
    else rawSend(reply)
  }

  // ---- member role ----

  function onmember (msg) {
    const r = request
    if (r === null || !r.sent || msg.type !== r.expects) {
      badMessage()
      return
    }
    if (msg.type === 'items') {
      let prevOk = true
      for (const it of msg.items) if (it.seq <= r.msg.after) prevOk = false
      if (!prevOk || msg.items.length > r.msg.limit) {
        badMessage()
        return
      }
    }
    request = null
    clearTimeout(r.timer)
    if (msg.type === 'ack') {
      r.resolve({ ok: msg.ok, reason: msg.reason })
      return
    }
    r.resolve({
      items: msg.items.map((it) => ({ seq: it.seq, bytes: b4a.from(it.drop, 'base64') })),
      next: msg.next,
      oldest: msg.oldest
    })
  }

  function memberPut (bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== DM_DROP_BYTES) {
      return Promise.reject(new TypeError('drop must be ' + DM_DROP_BYTES + ' bytes'))
    }
    return startRequest({ type: 'put', drop: b4a.toString(bytes, 'base64') }, 'ack')
  }

  function requestPage ({ after = 0, limit = DM_PAGE_MAX } = {}) {
    const msg = { type: 'page', after, limit }
    if (!validateDmMessage(msg)) return Promise.reject(new TypeError('invalid page request'))
    return startRequest(msg, 'items')
  }

  // The timeout runs from the call and is terminal: it rejects AND closes
  // the channel (the socket stays), so a late reply cannot answer a later
  // request.
  function startRequest (msg, expects) {
    if (ended || dropped) return Promise.reject(new Error('dm channel closed'))
    if (request !== null) return Promise.reject(new Error('a dm request is already in flight'))
    return new Promise((resolve, reject) => {
      const r = { msg, expects, sent: false, resolve, reject, timer: null }
      r.timer = setTimeout(() => {
        if (request !== r) return
        request = null
        reject(new Error('dm request timed out'))
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
  DM_PROTOCOL,
  MAX_BAD_DM,
  DM_REQUEST_TIMEOUT_MS,
  DM_MESSAGE_BURST,
  DM_MESSAGE_RATE,
  DM_PAGE_BURST,
  DM_PAGE_RATE,
  DM_PUT_BURST,
  DM_PUT_RATE,
  validateDmMessage,
  attachDm
}
