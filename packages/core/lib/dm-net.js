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
// One request in flight per socket, not per channel: a second put or page
// while one is unanswered is a bad message, also on a channel the member
// reopened while the first was still running. A request that settles after
// its channel closed answers nothing (never on a newer channel); one that
// throws closes the channel it came on, a no-op once that channel is gone.
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
//
// The bucketed lanes 'varanda/dm/2' and 'varanda/visit/2' are this channel
// again with a bucket (docs/protocol.md section 11, "Buckets"): the channel
// handshake is one uint, the bits of bucket, which the seeder opens with and
// the member opens with 0; put gains "bucket" (an integer below 2^bits, or
// null for untagged) and page gains "buckets" (non-empty, strictly ascending,
// at most 2^bits entries). The member API takes full 6-bit prefixes and
// truncates them itself after the handshake. A member that is told more than
// DM_BUCKET_BITS_MAX bits closes the channel. The v1 lanes are unchanged.
//
// The quiet visit lane 'varanda/visit/1' (opts.protocol = VISIT_PROTOCOL) is
// this same channel under another protocol name: the same messages, checks
// and rate buckets (its own, per channel), its own socket slot, and on the
// seeder its own pool, which wakes nobody. A seeder from before the lane
// rejects the open: the member's handle.supported resolves false, and the
// member treats the lane as unsupported there, never falling back to DMs.
const b4a = require('b4a')
const c = require('compact-encoding')
const clock = require('./clock')
const { hasExactKeys } = require('./records')
const { DM_PROTOCOL, VISIT_PROTOCOL, DM_PROTOCOL_V2, VISIT_PROTOCOL_V2, DM_BUCKET_BITS_MAX, DM_DROP_BYTES, DM_PAGE_MAX, DM_MAX_MESSAGE } = require('./dm')

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
// protocol -> { slot: default socket slot, tag: log event prefix, v2 }
const LANES = Object.freeze({
  [DM_PROTOCOL]: Object.freeze({ slot: '_varandaDm', tag: 'dm', v2: false }),
  [VISIT_PROTOCOL]: Object.freeze({ slot: '_varandaVisit', tag: 'visit', v2: false }),
  [DM_PROTOCOL_V2]: Object.freeze({ slot: '_varandaDm2', tag: 'dm', v2: true }),
  [VISIT_PROTOCOL_V2]: Object.freeze({ slot: '_varandaVisit2', tag: 'visit', v2: true })
})
// The dm and visit lanes of one socket share one 'close' listener: the
// seeder's _attachPeer hangs many channels on the same socket, and one
// listener per lane would cross the emitter's listener limit (a
// MaxListenersExceededWarning on every peer). As notices-net.js.
const CLOSE_HOOKS = Symbol('varanda dm close hooks')

function noop () {}

function onSocketClose (socket, fn) {
  if (typeof socket.once !== 'function') return
  let entry = socket[CLOSE_HOOKS]
  if (entry === undefined) {
    const hooks = new Set()
    const listener = () => {
      if (socket[CLOSE_HOOKS] === entry) delete socket[CLOSE_HOOKS]
      for (const f of [...hooks]) f()
    }
    entry = { hooks, listener }
    socket[CLOSE_HOOKS] = entry
    socket.once('close', listener)
  }
  entry.hooks.add(fn)
}

// The last lane gone detaches the shared listener, so a socket whose lanes
// all ended keeps no listener of this module.
function offSocketClose (socket, fn) {
  const entry = socket[CLOSE_HOOKS]
  if (entry === undefined) return
  entry.hooks.delete(fn)
  if (entry.hooks.size > 0) return
  delete socket[CLOSE_HOOKS]
  if (typeof socket.off === 'function') socket.off('close', entry.listener)
}

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

function isPrefix (n) {
  return Number.isSafeInteger(n) && n >= 0 && n < 2 ** DM_BUCKET_BITS_MAX
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

function isBucket (n, bits) {
  return Number.isSafeInteger(n) && n >= 0 && n < 2 ** bits
}

// Non-empty, strictly ascending, at most 2^bits entries, each below 2^bits.
function validBuckets (list, bits) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 2 ** bits) return false
  let prev = -1
  for (const b of list) {
    if (!isBucket(b, bits) || b <= prev) return false
    prev = b
  }
  return true
}

// Exact keys for every message of the channel. Never throws. v2 (the lane
// 'varanda/dm/2' or 'varanda/visit/2') adds a bucket to put and a bucket list
// to page, checked against the bits the channel's handshake fixed.
function validateDmMessage (msg, v2 = false, bits = 0) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'put':
        if (v2) {
          return hasExactKeys(msg, ['type', 'drop', 'bucket']) && isDropBase64(msg.drop) &&
            (msg.bucket === null || isBucket(msg.bucket, bits))
        }
        return hasExactKeys(msg, ['type', 'drop']) && isDropBase64(msg.drop)
      case 'page':
        if (v2) {
          if (!hasExactKeys(msg, ['type', 'after', 'limit', 'buckets']) || !validBuckets(msg.buckets, bits)) return false
        } else if (!hasExactKeys(msg, ['type', 'after', 'limit'])) {
          return false
        }
        return isCursor(msg.after) && Number.isSafeInteger(msg.limit) && msg.limit >= 1 && msg.limit <= DM_PAGE_MAX
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
  const protocol = opts.protocol === undefined ? DM_PROTOCOL : opts.protocol
  if (!Object.prototype.hasOwnProperty.call(LANES, protocol)) throw new TypeError('invalid protocol')
  const lane = LANES[protocol]
  const slot = opts.slot === undefined ? lane.slot : opts.slot
  if (typeof slot !== 'string' || slot === '') throw new TypeError('invalid slot')
  if (socket && socket[slot]) {
    // A slot already taken by the other lane is a caller error: returning
    // that handle would put a visit into the dm pool, or a dm into the visits.
    if (socket[slot].protocol !== protocol) throw new TypeError('slot in use by another protocol')
    return socket[slot]
  }

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
    putRate = DM_PUT_RATE,
    // Seeder on a v2 lane: the bits it advertises, fixed for the channel.
    bits: ownBits = 0
  } = opts
  const v2 = lane.v2

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder' && (typeof put !== 'function' || typeof page !== 'function')) {
    throw new TypeError('put and page must be functions')
  }
  if (!Number.isSafeInteger(ownBits) || ownBits < 0 || ownBits > DM_BUCKET_BITS_MAX) throw new TypeError('invalid bits')
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
  // The bits of this channel: our own advertised value on the seeder, the
  // seeder's on a member (known once the channel is open).
  let bits = role === 'seeder' ? ownBits : 0
  const inbound = tokenBucket(messageBurst, messageRate)
  const pages = tokenBucket(pageBurst, pageRate)
  const puts = tokenBucket(putBurst, putRate)

  // Seeder: whether a request is being answered, for the socket's lifetime, so
  // a reopened channel cannot start a second one. Member: the request being
  // waited for, with the reply type it expects.
  let answering = false
  let request = null

  const handle = {
    socket,
    role,
    protocol,
    badMessages: 0,
    v2,
    get bits () { return bits },
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') {
    handle.put = memberPut
    handle.requestPage = requestPage
  }
  socket[slot] = handle

  mux.pair({ protocol }, onpair)
  openChannel()
  onSocketClose(socket, end)

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol, onopen, onclose: onchannelclose, ...(v2 ? { handshake: c.uint } : {}) })
    if (ch === null) return
    channel = ch
    message = ch.addMessage({ encoding: c.buffer, onmessage: onraw })
    // The seeder says how many bits of bucket it uses; the member says 0 and
    // the seeder ignores it.
    if (v2) ch.open(role === 'seeder' ? ownBits : 0)
    else ch.open()
  }

  function onpair () {
    if (ended || dropped || channel !== null) return
    openChannel()
  }

  function onopen (handshake, ch) {
    if (ch !== channel || ended) return
    if (v2 && role === 'member') {
      // A seeder claiming more bits than the app ever takes could narrow a
      // recipient to a handful of people: the channel is bad.
      if (!Number.isSafeInteger(handshake) || handshake < 0 || handshake > DM_BUCKET_BITS_MAX) {
        close()
        return
      }
      bits = handshake
    }
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
    mux.unpair({ protocol })
    failRequest(new Error('dm channel closed'))
    settle(false)
    if (socket[slot] === handle) delete socket[slot]
    offSocketClose(socket, end)
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
    failRequest(new Error('dm peer dropped'))
    log({ event: 'peer-dropped', reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop(lane.tag)
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
    if (!validateDmMessage(msg, v2, bits)) {
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
        drop(lane.tag + '-page-rate')
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
      reply = ackFor(await (v2 ? put(b4a.from(msg.drop, 'base64'), { bucket: msg.bucket, bits }) : put(b4a.from(msg.drop, 'base64'))))
    } catch {
      log({ event: lane.tag + '-put-failed', reason: 'erro' })
    }
    answer(ch, reply)
  }

  async function answerPage (msg) {
    answering = true
    const ch = channel
    let reply = null
    try {
      const query = v2 ? { after: msg.after, limit: msg.limit, buckets: msg.buckets, bits } : { after: msg.after, limit: msg.limit }
      reply = itemsMessage(await page(query), msg.after, msg.limit, maxBytes)
      if (reply === null) log({ event: lane.tag + '-page-invalid' })
    } catch {
      log({ event: lane.tag + '-page-failed', reason: 'erro' })
    }
    answer(ch, reply)
  }

  // ch: the channel the request came on. A null reply closes only that one.
  function answer (ch, reply) {
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

  // prefix: the drop's FULL 6-bit prefix (bucketPrefix), or null when the
  // box it is sealed to is unknown; truncated here to the channel's bits, so
  // callers never depend on the seeder's bits. Ignored on a v1 lane.
  function memberPut (bytes, prefix = null) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== DM_DROP_BYTES) {
      return Promise.reject(new TypeError('drop must be ' + DM_DROP_BYTES + ' bytes'))
    }
    if (prefix !== null && !isPrefix(prefix)) return Promise.reject(new TypeError('invalid prefix'))
    const drop = b4a.toString(bytes, 'base64')
    return startRequest(() => v2
      ? { type: 'put', drop, bucket: prefix === null ? null : prefix >> (DM_BUCKET_BITS_MAX - bits) }
      : { type: 'put', drop }, 'ack')
  }

  // prefixes: 6-bit prefixes to read (deduplicated and sorted after the
  // truncation); left out, every bucket. Ignored on a v1 lane, which returns
  // the whole pool.
  function requestPage ({ after = 0, limit = DM_PAGE_MAX, prefixes } = {}) {
    if (!validateDmMessage({ type: 'page', after, limit })) return Promise.reject(new TypeError('invalid page request'))
    if (prefixes !== undefined && (!Array.isArray(prefixes) || prefixes.length < 1 || !prefixes.every(isPrefix))) {
      return Promise.reject(new TypeError('invalid prefixes'))
    }
    return startRequest(() => {
      if (!v2) return { type: 'page', after, limit }
      const all = prefixes === undefined ? Array.from({ length: 2 ** bits }, (_, i) => i) : prefixes.map((p) => p >> (DM_BUCKET_BITS_MAX - bits))
      return { type: 'page', after, limit, buckets: [...new Set(all)].sort((a, b) => a - b) }
    }, 'items')
  }

  // The timeout runs from the call and is terminal: it rejects AND closes
  // the channel (the socket stays), so a late reply cannot answer a later
  // request.
  function startRequest (make, expects) {
    if (ended || dropped) return Promise.reject(new Error('dm channel closed'))
    if (request !== null) return Promise.reject(new Error('a dm request is already in flight'))
    return new Promise((resolve, reject) => {
      const r = { make, msg: null, expects, sent: false, resolve, reject, timer: null }
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
    // Built now, not at the call: the bits are known only once the channel is open.
    const msg = r.make()
    if (!validateDmMessage(msg, v2, bits)) {
      request = null
      clearTimeout(r.timer)
      r.reject(new TypeError('invalid dm request'))
      return
    }
    r.msg = msg
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
  VISIT_PROTOCOL,
  DM_PROTOCOL_V2,
  VISIT_PROTOCOL_V2,
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
