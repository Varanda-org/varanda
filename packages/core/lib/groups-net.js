'use strict'

// Browser-safe groups channel: 'varanda/groups/1' on the protomux that the
// hypercore replication stream already put in socket.noiseStream.userData
// (the muxer the admission, blocklist and notices channels use). A member
// asks a seeder for the writer set of a group, a page at a time; the index
// itself lives in the seeder (group-index.js, injected here as `page`).
// Writer sets are public (docs/protocol.md), so there is no proof: whatever
// the seeder answers is untrusted until the member has gated each writer
// core itself (header, quarantine, certificates, blocklist).
//
// Flow (all messages JSON in one c.buffer message type):
//   member -> seeder  { type: 'writers', group, after, limit }
//   seeder -> member  { type: 'writers', group, items, next, incomplete }
// `after` and `next` are the last writer key of a page (hex64) or null.
// Items are { key, diary, length, seq }: the writer core, its diary, the
// core length the seeder knows and the seq of the join that admitted it.
// The seeder answers one request at a time; the reply echoes the group.
//
// Bad messages: a frame over maxBytes, a JSON or shape failure, a second
// request while one is unanswered, a reply nobody asked for or for another
// group, and any message of the other role. More than maxBad of them drops
// the peer (socket.destroy()). Message rate: the per-connection token bucket
// of blocklist-net.js, checked before JSON.parse; a peer out of tokens is
// dropped with 'message-rate'.
//
// Compatibility: a peer from before groups rejects our open; `supported`
// resolves false and the socket is NEVER destroyed for it.
//
// Lifetime: a member handle is single-use per channel, as in notices-net.js.
// A request timeout is terminal for the channel (never for the socket): the
// late reply has nowhere to land.
const b4a = require('b4a')
const c = require('compact-encoding')
const clock = require('./clock')
const { MESSAGE_BURST, MESSAGE_RATE } = require('./blocklist-net')

const GROUPS_PROTOCOL = 'varanda/groups/1'
const MAX_GROUPS_MESSAGE = 16384
const MAX_BAD_GROUPS = 5 // more than this many bad messages drops the peer
const GROUPS_LIMIT_MAX = 64
const GROUPS_REQUEST_TIMEOUT_MS = 10000

const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function isHex64 (v) {
  return typeof v === 'string' && HEX64.test(v)
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isCount (v) {
  return Number.isSafeInteger(v) && v >= 0
}

function validCursor (v) {
  return v === null || isHex64(v)
}

function validLimit (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= GROUPS_LIMIT_MAX
}

function validItem (it) {
  return isPlainObject(it) &&
    hasExactKeys(it, ['key', 'diary', 'length', 'seq']) &&
    isHex64(it.key) && isHex64(it.diary) && isCount(it.length) &&
    Number.isSafeInteger(it.seq) && it.seq >= 1 // diary block 0 is the certificate, never a join
}

// Exact keys and lower-case hex for every message of the channel. Never
// throws on hostile input (getters, proxies, odd prototypes).
function validateGroupsMessage (msg) {
  try {
    if (!isPlainObject(msg) || msg.type !== 'writers') return false
    if (Object.prototype.hasOwnProperty.call(msg, 'items')) {
      if (!hasExactKeys(msg, ['type', 'group', 'items', 'next', 'incomplete'])) return false
      if (!isHex64(msg.group) || !Array.isArray(msg.items) || msg.items.length > GROUPS_LIMIT_MAX) return false
      for (let i = 0; i < msg.items.length; i++) {
        if (!validItem(msg.items[i])) return false
      }
      return validCursor(msg.next) && typeof msg.incomplete === 'boolean'
    }
    return hasExactKeys(msg, ['type', 'group', 'after', 'limit']) &&
      isHex64(msg.group) && validCursor(msg.after) && validLimit(msg.limit)
  } catch {
    return false
  }
}

function isReply (msg) {
  return Array.isArray(msg.items)
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

function emptyReply (group) {
  return { type: 'writers', group, items: [], next: null, incomplete: true }
}

// Our own reply from a page() result, or null when it would not pass the
// receiver's validation (never send what the peer counts as bad).
function replyMessage (group, result, maxBytes) {
  try {
    if (result === null || typeof result !== 'object' || !Array.isArray(result.items)) return null
    const items = result.items.map((it) => ({ key: it.key, diary: it.diary, length: it.length, seq: it.seq }))
    const next = result.next === null || result.next === undefined ? null : result.next
    const msg = { type: 'writers', group, items, next, incomplete: result.incomplete === true }
    if (!validateGroupsMessage(msg)) return null
    if (b4a.byteLength(JSON.stringify(msg)) > maxBytes) return null
    return msg
  } catch {
    return null
  }
}

function attachGroups (socket, opts = {}) {
  if (socket && socket._varandaGroups) return socket._varandaGroups

  const {
    role,
    page,
    log = noop,
    maxBytes = MAX_GROUPS_MESSAGE,
    maxBad = MAX_BAD_GROUPS,
    messageBurst = MESSAGE_BURST,
    messageRate = MESSAGE_RATE,
    requestTimeoutMs = GROUPS_REQUEST_TIMEOUT_MS
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder' && typeof page !== 'function') throw new TypeError('page must be a function')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid message rate limits')
  if (!(requestTimeoutMs > 0)) throw new TypeError('invalid requestTimeoutMs')

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachGroups')

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  const inbound = tokenBucket(messageBurst, messageRate)

  // Seeder state (per channel): whether a request is being answered.
  let answering = false

  // Member state: the request being waited for (its timeout closes the
  // channel, so a reply never arrives for a request we no longer hold).
  let request = null

  const handle = {
    peerKey: socket.remotePublicKey ? hex(socket.remotePublicKey) : null,
    socket,
    role,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') handle.requestWriters = requestWriters
  socket._varandaGroups = handle

  // Whichever side opens first is paired (blocklist-net.js).
  mux.pair({ protocol: GROUPS_PROTOCOL }, onpair)
  openChannel()
  if (typeof socket.once === 'function') socket.once('close', end)

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol: GROUPS_PROTOCOL, onopen, onclose: onchannelclose })
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

  // A close before the open completed is the remote rejecting our open or
  // the transport going away. The socket is left alone. A member is finished
  // by any close (single-use); a seeder stays paired so a peer that reopens
  // starts from a clean channel.
  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    failRequest(new Error('groups channel closed'))
    if (!wasOpen) settle(false)
    if (role === 'member') end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol: GROUPS_PROTOCOL })
    failRequest(new Error('groups channel closed'))
    settle(false)
    if (socket._varandaGroups === handle) delete socket._varandaGroups
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
    failRequest(new Error('groups peer dropped'))
    log({ event: 'peer-dropped', peerKey: handle.peerKey, reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop('groups')
  }

  function onraw (buf) {
    if (ended || dropped) return
    // Every message costs one token, valid or not, before any parsing.
    if (!inbound.take()) {
      drop('message-rate')
      return
    }
    let msg
    try {
      // Size is checked on the raw buffer, before any parsing.
      if (!buf || buf.byteLength === 0 || buf.byteLength > maxBytes) {
        badMessage()
        return
      }
      msg = JSON.parse(b4a.toString(buf, 'utf8'))
    } catch {
      badMessage()
      return
    }
    if (!validateGroupsMessage(msg)) {
      badMessage()
      return
    }
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (isReply(msg) || answering) {
      badMessage() // a reply, or a second request while one is unanswered
      return
    }
    answer(msg)
  }

  // Not awaited by protomux: a rejected promise there destroys the stream.
  async function answer (msg) {
    answering = true
    const ch = channel
    let reply = null
    try {
      const result = await page({ group: msg.group, after: msg.after, limit: msg.limit })
      reply = replyMessage(msg.group, result, maxBytes)
      if (reply === null) log({ event: 'groups-page-invalid', peerKey: handle.peerKey })
    } catch (err) {
      log({ event: 'groups-page-failed', peerKey: handle.peerKey, error: err && err.message })
    }
    if (ch !== channel || ended || dropped) return
    answering = false
    rawSend(reply || emptyReply(msg.group))
  }

  // ---- member role ----

  function onmember (msg) {
    const r = request
    if (!isReply(msg) || r === null || !r.sent || msg.group !== r.msg.group) {
      badMessage() // a request, or a reply nobody asked for
      return
    }
    request = null
    clearTimeout(r.timer)
    // A fresh copy from JSON.parse, already validated.
    r.resolve({ group: msg.group, items: msg.items, next: msg.next, incomplete: msg.incomplete })
  }

  // One request in flight at a time. The timeout runs from the call and is
  // terminal: it rejects AND closes the channel (the socket stays), so a late
  // reply cannot be mistaken for a later request's answer.
  function requestWriters ({ group, after = null, limit = GROUPS_LIMIT_MAX } = {}) {
    if (ended || dropped) return Promise.reject(new Error('groups channel closed'))
    if (request !== null) return Promise.reject(new Error('a groups request is already in flight'))
    const msg = { type: 'writers', group, after, limit }
    if (!validateGroupsMessage(msg)) return Promise.reject(new Error('invalid writers request'))
    return new Promise((resolve, reject) => {
      const r = { msg, sent: false, resolve, reject, timer: null }
      r.timer = setTimeout(() => {
        if (request !== r) return
        request = null
        reject(new Error('groups request timed out'))
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
  GROUPS_PROTOCOL,
  PROTOCOL: GROUPS_PROTOCOL,
  MAX_GROUPS_MESSAGE,
  MAX_BAD_GROUPS,
  GROUPS_LIMIT_MAX,
  GROUPS_REQUEST_TIMEOUT_MS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  validateGroupsMessage,
  attachGroups
}
