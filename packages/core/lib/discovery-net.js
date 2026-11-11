'use strict'

// Browser-safe discovery channel: 'varanda/discovery/1' on the protomux that
// the hypercore replication stream already put in socket.noiseStream.userData
// (the muxer the admission, blocklist and notices channels use). A member
// pages through a seeder's inventory (which diaries it holds and how long
// each is) instead of waiting for the whole hello; the inventory itself
// lives in the seeder and is injected here as `page`.
//
// Flow (all messages JSON in one c.buffer message type, at most
// MAX_DISCOVERY_MESSAGE bytes):
//   member -> seeder  { type: 'page', id, after, limit[, view] }
//   seeder -> member  { type: 'page', id, view, items, next, total }
//                  or { type: 'page', id, stale: true }
// `id` is a safe integer >= 1 chosen by the member and echoed back; `after`
// and `next` are null or a cursor { t, h } (t a safe integer >= 0, h a
// lowercase hex64); `items` are at most `limit` entries { key, length } with
// distinct keys; `total` is the size of the whole view. `view` names the
// snapshot the seeder pages from (16 random bytes in lowercase hex,
// newViewId()). A member carries it back so later pages come from the same
// snapshot; once the seeder no longer holds that view it answers stale and
// the member starts over. Lengths are unsigned hints, as in the hello: a
// member checks them against the diary itself before trusting anything.
//
// Seeder role: answers each valid request synchronously from
// page({ after, limit, view }), which returns { view, items, next, total } or
// { stale: true }. A page() that throws or returns something the member would
// count as bad is logged and answered stale, so every request gets exactly
// one answer and only one request is ever being answered on a link. The
// seeder sends nothing unsolicited.
//
// Bad messages: a frame over maxBytes, a JSON or shape failure, a message of
// the other role, an answer nobody asked for or whose id, item count or view
// does not match the request. More than maxBad of them drops the peer
// (socket.destroy(), as the other channels do). Inbound rate on the seeder: a
// token bucket (DISCOVERY_BURST at DISCOVERY_RATE per second) checked before
// JSON.parse, and at most MAX_DISCOVERY_REQUESTS requests per link; a peer
// over either is dropped with a logged reason. The member paces its own
// requests to one per DISCOVERY_PACE_MS (exactly the refill rate, so an
// honest member never drains the bucket) and stops itself at the same cap.
//
// Compatibility: a peer from before discovery rejects our open (protomux
// _rejectSession); `supported` resolves false and the socket is never
// destroyed for it.
//
// Lifetime: a handle is single-use per channel, as in notices-net.js. A
// request timeout rejects and closes the channel (never the socket), so a
// late answer cannot land on a later request; a close rejects the request in
// flight and every later one with 'closed', and releases the socket's cached
// handle so a caller may attach afresh.
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const clock = require('./clock')
const { MAX_LOG_BLOCKS } = require('./records')
const { MAX_INVENTORY } = require('./admission')

const PROTOCOL = 'varanda/discovery/1'
const SLOT = '_varandaDiscovery'
const MAX_DISCOVERY_MESSAGE = 16384
const MAX_DISCOVERY_LIMIT = 64
const MAX_BAD_DISCOVERY = 5 // more than this many bad messages drops the peer
const DISCOVERY_BURST = 8
const DISCOVERY_RATE = 4 // tokens per second
const MAX_DISCOVERY_REQUESTS = 160 // per link
const DISCOVERY_PACE_MS = 250 // 1000 / DISCOVERY_RATE
const MAX_PAGES_PER_READ = 8
const DISCOVERY_REQUEST_TIMEOUT_MS = 5000

const HEX64 = /^[0-9a-f]{64}$/
const VIEW_RE = /^[0-9a-f]{32}$/

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function newViewId () {
  return hex(hcrypto.randomBytes(16))
}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  if (own.length !== keys.length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  }
  return true
}

function isId (n) {
  return Number.isSafeInteger(n) && n >= 1
}

function isView (v) {
  return typeof v === 'string' && VIEW_RE.test(v)
}

function isLimit (n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_DISCOVERY_LIMIT
}

function isCursor (cur) {
  if (cur === null) return true
  return isPlainObject(cur) &&
    hasExactKeys(cur, ['t', 'h']) &&
    Number.isSafeInteger(cur.t) && cur.t >= 0 &&
    typeof cur.h === 'string' && HEX64.test(cur.h)
}

function isItem (it) {
  return isPlainObject(it) &&
    hasExactKeys(it, ['key', 'length']) &&
    typeof it.key === 'string' && HEX64.test(it.key) &&
    Number.isSafeInteger(it.length) && it.length >= 0 && it.length <= MAX_LOG_BLOCKS
}

function validateRequest (msg) {
  if (!isPlainObject(msg) || msg.type !== 'page') return false
  const withView = Object.prototype.hasOwnProperty.call(msg, 'view')
  const keys = withView ? ['type', 'id', 'after', 'limit', 'view'] : ['type', 'id', 'after', 'limit']
  if (!hasExactKeys(msg, keys)) return false
  if (withView && !isView(msg.view)) return false
  return isId(msg.id) && isCursor(msg.after) && isLimit(msg.limit)
}

// The shape of an answer; `limit` (when given) bounds the item count.
function validateAnswer (msg, limit = MAX_DISCOVERY_LIMIT) {
  if (!isPlainObject(msg) || msg.type !== 'page' || !isId(msg.id)) return false
  if (Object.prototype.hasOwnProperty.call(msg, 'stale')) {
    return hasExactKeys(msg, ['type', 'id', 'stale']) && msg.stale === true
  }
  if (!hasExactKeys(msg, ['type', 'id', 'view', 'items', 'next', 'total'])) return false
  if (!isView(msg.view) || !isCursor(msg.next)) return false
  if (!Number.isSafeInteger(msg.total) || msg.total < 0 || msg.total > MAX_INVENTORY) return false
  if (!Array.isArray(msg.items) || msg.items.length > limit || msg.items.length > MAX_DISCOVERY_LIMIT) return false
  const seen = new Set()
  for (const it of msg.items) {
    if (!isItem(it) || seen.has(it.key)) return false
    seen.add(it.key)
  }
  return true
}

// Same token bucket as blocklist-net.js (take() only).
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

// Our own answer from a page() result, or null when the member would count
// it as bad (never send what the peer drops us for).
function answerMessage (id, result, limit, maxBytes) {
  try {
    if (!isPlainObject(result)) return null
    let msg
    if (result.stale === true) {
      msg = { type: 'page', id, stale: true }
    } else {
      if (!Array.isArray(result.items)) return null
      const items = result.items.map((it) => ({ key: it.key, length: it.length }))
      const n = result.next
      const next = n === null || n === undefined ? null : { t: n.t, h: n.h }
      msg = { type: 'page', id, view: result.view, items, next, total: result.total }
    }
    if (!validateAnswer(msg, limit)) return null
    if (b4a.byteLength(JSON.stringify(msg)) > maxBytes) return null
    return msg
  } catch {
    return null
  }
}

function attachDiscovery (socket, opts = {}) {
  if (socket && socket[SLOT]) return socket[SLOT]

  const {
    role,
    page,
    log = noop,
    requestTimeoutMs = DISCOVERY_REQUEST_TIMEOUT_MS,
    maxBytes = MAX_DISCOVERY_MESSAGE,
    maxBad = MAX_BAD_DISCOVERY,
    messageBurst = DISCOVERY_BURST,
    messageRate = DISCOVERY_RATE,
    maxRequests = MAX_DISCOVERY_REQUESTS,
    paceMs = DISCOVERY_PACE_MS
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder' && typeof page !== 'function') throw new TypeError('page must be a function')
  if (typeof log !== 'function') throw new TypeError('log must be a function')
  if (!(requestTimeoutMs > 0)) throw new TypeError('invalid requestTimeoutMs')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid message rate limits')
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new TypeError('invalid maxRequests')
  if (!(paceMs >= 0)) throw new TypeError('invalid paceMs')

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachDiscovery')

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  const inbound = tokenBucket(messageBurst, messageRate)

  // Seeder state: valid requests answered on this link.
  let requestsSeen = 0

  // Member state: the request being waited for, the last id and send time
  // (pacing) and how many requests this link has sent.
  let request = null
  let lastId = 0
  let lastSentAt = -Infinity
  let requestsSent = 0

  const handle = {
    peerKey: socket.remotePublicKey ? hex(socket.remotePublicKey) : null,
    socket,
    role,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') {
    handle.page = requestPage
    handle.read = read
  }
  socket[SLOT] = handle

  // Whichever side opens first is paired (blocklist-net.js).
  mux.pair({ protocol: PROTOCOL }, onpair)
  openChannel()
  if (typeof socket.once === 'function') socket.once('close', end)

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol: PROTOCOL, onopen, onclose: onchannelclose })
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
  }

  // A close before the open completed is the remote rejecting our open or
  // the transport going away: the socket is left alone. A member is finished
  // by any close; a seeder stays paired so a peer that reopens is answered
  // (the per-link request cap and bucket carry over).
  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    failRequest(new Error('discovery channel closed'))
    if (!wasOpen) settle(false)
    if (role === 'member') end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol: PROTOCOL })
    failRequest(new Error('discovery channel closed'))
    settle(false)
    if (socket[SLOT] === handle) delete socket[SLOT]
    if (typeof socket.removeListener === 'function') socket.removeListener('close', end)
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
    failRequest(new Error('discovery peer dropped'))
    log({ event: 'peer-dropped', peerKey: handle.peerKey, reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop('discovery')
  }

  function onraw (buf) {
    if (ended || dropped) return
    // Every inbound message costs one token on the seeder, before parsing.
    if (role === 'seeder' && !inbound.take()) {
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
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (!validateRequest(msg)) {
      badMessage()
      return
    }
    if (requestsSeen >= maxRequests) {
      drop('discovery-request-cap')
      return
    }
    requestsSeen++
    const view = Object.prototype.hasOwnProperty.call(msg, 'view') ? msg.view : null
    let reply = null
    try {
      const result = page({ after: msg.after, limit: msg.limit, view })
      reply = answerMessage(msg.id, result, msg.limit, maxBytes)
      // A request that named a view gets that view or stale: another view
      // would be bad on the member and strand its request until the timeout.
      if (reply !== null && view !== null && reply.stale !== true && reply.view !== view) reply = null
      if (reply === null) log({ event: 'discovery-page-invalid', peerKey: handle.peerKey })
    } catch (err) {
      log({ event: 'discovery-page-failed', peerKey: handle.peerKey, error: err && err.message })
    }
    rawSend(reply || { type: 'page', id: msg.id, stale: true })
  }

  // ---- member role ----

  function onmember (msg) {
    const r = request
    if (r === null || !r.sent || !isPlainObject(msg) || msg.id !== r.msg.id) {
      badMessage() // never asked for, or not this request's answer
      return
    }
    if (!validateAnswer(msg, r.msg.limit)) {
      badMessage()
      return
    }
    // A request that named a view gets that view back, or stale.
    if (msg.stale !== true && r.msg.view !== undefined && msg.view !== r.msg.view) {
      badMessage()
      return
    }
    request = null
    clearTimeout(r.timer)
    if (msg.stale === true) r.resolve({ stale: true })
    else r.resolve({ view: msg.view, items: msg.items, next: msg.next, total: msg.total })
  }

  // One request in flight at a time, sent no sooner than paceMs after the
  // previous one. The timeout runs from the send and is terminal: it rejects
  // and closes the channel (the socket stays).
  function requestPage ({ after = null, limit = MAX_DISCOVERY_LIMIT, view = null } = {}) {
    if (ended || dropped) return Promise.reject(new Error('discovery channel closed'))
    if (request !== null) return Promise.reject(new Error('a discovery page is already in flight'))
    if (requestsSent >= maxRequests) return Promise.reject(new Error('discovery request cap reached'))
    const msg = { type: 'page', id: lastId + 1, after, limit }
    if (view !== null) msg.view = view
    if (!validateRequest(msg)) return Promise.reject(new TypeError('invalid page request'))
    lastId = msg.id
    requestsSent++
    return new Promise((resolve, reject) => {
      const r = { msg, sent: false, resolve, reject, timer: null, pacer: null }
      request = r
      const wait = Math.max(0, lastSentAt + paceMs - clock.now())
      // Reserved now, so the next request paces from this one's slot.
      lastSentAt = clock.now() + wait
      if (wait > 0) r.pacer = setTimeout(() => sendRequest(r), wait)
      else sendRequest(r)
    })
  }

  function sendRequest (r) {
    r.pacer = null
    if (request !== r) return
    if (!isOpen) {
      // Not open yet: the wait for the open is bounded by the same timeout,
      // and the answer gets a full timeout from the send.
      armTimeout(r)
      if (settled) {
        failRequest(new Error('discovery channel closed'))
        return
      }
      handle.supported.then(() => {
        if (request !== r || r.sent || !rawSend(r.msg)) return
        r.sent = true
        clearTimeout(r.timer)
        r.timer = null
        armTimeout(r)
      })
      return
    }
    if (!rawSend(r.msg)) return
    r.sent = true
    armTimeout(r)
  }

  function armTimeout (r) {
    if (r.timer !== null) return
    // Not unref'd: a caller awaiting a page holds the loop until the answer
    // or the timeout (bounded, and cleared on either).
    r.timer = setTimeout(() => {
      if (request !== r) return
      request = null
      r.reject(new Error('discovery page timed out'))
      close()
    }, requestTimeoutMs)
  }

  function failRequest (err) {
    const r = request
    if (r === null) return
    request = null
    clearTimeout(r.timer)
    clearTimeout(r.pacer)
    r.reject(err)
  }

  // Pages from the start to the end in at most maxPages requests (never more
  // than MAX_PAGES_PER_READ), following the view. A stale answer ends the read
  // without restarting it: it resolves with what it had, view null,
  // complete false and stale true, and the caller starts over on its next
  // read (a fresh view from the start).
  async function read ({ limit = MAX_DISCOVERY_LIMIT, maxPages = MAX_PAGES_PER_READ } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('invalid maxPages')
    const budget = Math.min(maxPages, MAX_PAGES_PER_READ)
    let items = []
    let after = null
    let view = null
    let total = 0
    for (let i = 0; i < budget; i++) {
      const res = await requestPage({ after, limit, view })
      if (res.stale) return { view: null, items, total, complete: false, stale: true }
      view = res.view
      total = res.total
      items = items.concat(res.items)
      if (res.next === null) return { view, items, total, complete: true }
      after = res.next
    }
    return { view, items, total, complete: false }
  }
}

module.exports = {
  PROTOCOL,
  MAX_DISCOVERY_MESSAGE,
  MAX_DISCOVERY_LIMIT,
  MAX_BAD_DISCOVERY,
  DISCOVERY_BURST,
  DISCOVERY_RATE,
  MAX_DISCOVERY_REQUESTS,
  DISCOVERY_PACE_MS,
  MAX_PAGES_PER_READ,
  DISCOVERY_REQUEST_TIMEOUT_MS,
  newViewId,
  validateRequest,
  validateAnswer,
  attachDiscovery
}
