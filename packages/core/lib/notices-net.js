'use strict'

// Browser-safe notices channel: 'varanda/notices/1' on the protomux that the
// hypercore replication stream already put in socket.noiseStream.userData
// (the muxer the admission and blocklist channels use, blocklist-net.js).
// A member asks the seeder "who started following me" (docs/protocol.md,
// Notices channel (varanda/notices/1)); the follower index itself lives in
// the seeder (notices.js createNoticeIndex, injected here as `page`).
//
// Flow (all messages JSON in one c.buffer message type):
//   seeder -> member  { type: 'challenge', nonce }       once, on open
//   member -> seeder  { type: 'proof', key, sig }        once
//   member -> seeder  { type: 'page', after, limit }     one at a time
//   seeder -> member  { type: 'items', items, next, incomplete }
// The proof is an Ed25519 signature by the diary key over noticePayload(
// nonce, the member's Noise public key, key). The seeder checks it against
// the remotePublicKey of THIS connection, so a proof is useless on any other
// connection (no replay, no relay), and binds the connection to that key:
// every page is the bound key's followers, whatever the member asks. The
// seeder sends no ack; a failed proof is just a bad message and pages stay
// refused.
//
// Bad messages: a frame over maxBytes, a JSON or shape failure, a page
// before a valid proof, a failed or second proof, a second page while one is
// unanswered, a second challenge, unsolicited items, and any message of the
// other role. More than maxBad of them drops the peer (socket.destroy(), as
// the admission and blocklist channels do). Message rate: the per-connection
// token bucket of blocklist-net.js (MESSAGE_BURST, MESSAGE_RATE), checked
// before JSON.parse; a peer out of tokens is dropped with 'message-rate'.
//
// Compatibility: a peer from before notices rejects our open (protomux
// _rejectSession); `supported` resolves false and the socket is NEVER
// destroyed for it, exactly as blocklist-net.js onchannelclose.
//
// Lifetime: a member handle is single-use per channel. Once its channel
// closes for any reason (rejected open, seeder close, page timeout, drop,
// socket close) it is finished: `proved` settles (false unless a proof was
// sent or sign() threw), the in-flight request rejects, requestPage rejects
// with 'closed' and the socket's cached handle is released so a caller may
// attach a fresh channel. A page timeout is terminal for the channel (never
// for the socket): the late reply has nowhere to land, so no stale state
// survives. The seeder side is per channel too: a peer that reopens gets a
// fresh challenge and no binding (openChannel resets every field).
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const clock = require('./clock')
const { MESSAGE_BURST, MESSAGE_RATE } = require('./blocklist-net')
const {
  NOTICES_PROTOCOL,
  NOTICES_LIMIT_DEFAULT,
  MAX_NOTICES_MESSAGE,
  noticePayload,
  verifyNoticeProof,
  validateNoticesMessage
} = require('./notices')
const {
  NOTICES_V2_PROTOCOL,
  noticeV2Payload,
  verifyNoticeV2Proof,
  validateNoticesV2Message
} = require('./notices-v2')

const PROTOCOL = NOTICES_PROTOCOL
const MAX_BAD_NOTICES = 5 // more than this many bad messages drops the peer
const NOTICES_REQUEST_TIMEOUT_MS = 10000

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
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

function emptyPage () {
  return { type: 'items', items: [], next: null, incomplete: true }
}

function projectItemV1 (it) {
  return { key: it.key, seq: it.seq, at: it.at }
}

function projectCursorV1 (cur) {
  return { at: cur.at, key: cur.key }
}

function projectItemV2 (it) {
  return { key: it.key, seq: it.seq, at: it.at, kind: it.kind }
}

function projectCursorV2 (cur) {
  return { at: cur.at, key: cur.key, seq: cur.seq }
}

// Our own items message from a page() result, or null when it would not
// pass the receiver's validation (never send what the peer counts as bad).
function itemsMessage (result, maxBytes, validate, projectItem, projectCursor) {
  try {
    if (result === null || typeof result !== 'object' || !Array.isArray(result.items)) return null
    const items = result.items.map(projectItem)
    const next = result.next === null || result.next === undefined ? null : projectCursor(result.next)
    const msg = { type: 'items', items, next, incomplete: result.incomplete === true }
    if (!validate(msg)) return null
    if (b4a.byteLength(JSON.stringify(msg)) > maxBytes) return null
    return msg
  } catch {
    return null
  }
}

// The defaults are 'varanda/notices/1'; attachNoticesV2 passes its own
// bundle. Each protocol keeps its handle in its own socket slot so both
// channels coexist on one connection.
function attachNotices (socket, opts = {}) {
  const slot = opts.slot === undefined ? '_varandaNotices' : opts.slot
  if (typeof slot !== 'string' || slot === '') throw new TypeError('invalid slot')
  if (socket && socket[slot]) return socket[slot]

  const {
    role,
    page,
    ownKey,
    sign,
    log = noop,
    maxBytes = MAX_NOTICES_MESSAGE,
    maxBad = MAX_BAD_NOTICES,
    messageBurst = MESSAGE_BURST,
    messageRate = MESSAGE_RATE,
    requestTimeoutMs = NOTICES_REQUEST_TIMEOUT_MS,
    protocol = PROTOCOL,
    validate = validateNoticesMessage,
    payload = noticePayload,
    verify = verifyNoticeProof,
    projectItem = projectItemV1,
    projectCursor = projectCursorV1,
    dropReason = 'notices',
    invalidEvent = 'notices-page-invalid',
    failedEvent = 'notices-page-failed'
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder' && typeof page !== 'function') throw new TypeError('page must be a function')
  if (role === 'member') {
    if (typeof ownKey !== 'string' || !/^[0-9a-f]{64}$/.test(ownKey)) throw new TypeError('invalid ownKey')
    if (typeof sign !== 'function') throw new TypeError('sign must be a function')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid message rate limits')
  if (!(requestTimeoutMs > 0)) throw new TypeError('invalid requestTimeoutMs')
  if (typeof protocol !== 'string' || protocol === '') throw new TypeError('invalid protocol')
  for (const fn of [validate, payload, verify, projectItem, projectCursor]) {
    if (typeof fn !== 'function') throw new TypeError('invalid protocol bundle')
  }

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachNotices')

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  const inbound = tokenBucket(messageBurst, messageRate)

  // Seeder state (per channel): the nonce we sent, whether a proof arrived,
  // the key it proved and whether a page is being answered.
  let nonce = null
  let proofSeen = false
  let boundKey = null
  let answering = false

  // Member state: whether a challenge arrived on this channel, the proved
  // promise and the request being waited for (its timeout closes the
  // channel, so a reply never arrives for a request we no longer hold).
  let challengeSeen = false
  let provedDone = false
  let resolveProved = noop
  let rejectProved = noop
  let request = null

  const handle = {
    peerKey: socket.remotePublicKey ? hex(socket.remotePublicKey) : null,
    socket,
    role,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') {
    handle.proved = new Promise((resolve, reject) => {
      resolveProved = resolve
      rejectProved = reject
    })
    // Marked handled here: a caller that never awaits `proved` must not
    // turn a locked identity into an unhandled rejection. Awaiting it still
    // sees the rejection.
    handle.proved.catch(noop)
    handle.requestPage = requestPage
  }
  socket[slot] = handle

  // Whichever side opens first is paired (blocklist-net.js).
  mux.pair({ protocol }, onpair)
  openChannel()
  if (typeof socket.once === 'function') socket.once('close', end)

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function settleProved (ok, err) {
    if (provedDone) return
    provedDone = true
    if (err) rejectProved(err)
    else resolveProved(ok)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol, onopen, onclose: onchannelclose })
    if (ch === null) return
    channel = ch
    nonce = null
    proofSeen = false
    boundKey = null
    answering = false
    challengeSeen = false
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
    if (role === 'seeder') {
      nonce = hex(hcrypto.randomBytes(32))
      rawSend({ type: 'challenge', nonce })
    }
  }

  // A close before the open completed is the remote rejecting our open or
  // the transport going away. The socket is left alone. A member is finished
  // by any close (single-use, see the header); a seeder stays paired so a
  // peer that reopens starts from a clean channel.
  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    failRequest(new Error('notices channel closed'))
    if (!wasOpen) settle(false)
    if (role === 'member') end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol })
    failRequest(new Error('notices channel closed'))
    settle(false)
    settleProved(false)
    if (socket[slot] === handle) delete socket[slot]
    // A finished handle must not stay reachable from a live socket that a
    // caller attaches to again.
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
    failRequest(new Error('notices peer dropped'))
    log({ event: 'peer-dropped', peerKey: handle.peerKey, reason })
    const ch = channel
    if (ch !== null) ch.close()
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) drop(dropReason)
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
    if (!validate(msg)) {
      badMessage()
      return
    }
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (msg.type === 'proof') {
      // Exactly one proof per channel, verified against THIS connection.
      if (proofSeen || nonce === null || !socket.remotePublicKey) {
        badMessage()
        return
      }
      proofSeen = true
      if (!verify({ nonce, noise: hex(socket.remotePublicKey), key: msg.key }, msg.sig)) {
        badMessage()
        return
      }
      boundKey = msg.key
      return
    }
    if (msg.type === 'page') {
      if (boundKey === null || answering) {
        badMessage()
        return
      }
      answer(msg)
      return
    }
    badMessage() // challenge or items: the member never sends these
  }

  // Not awaited by protomux: a rejected promise there destroys the stream.
  async function answer (msg) {
    answering = true
    const ch = channel
    let reply = null
    try {
      const result = await page({ target: boundKey, after: msg.after, limit: msg.limit })
      reply = itemsMessage(result, maxBytes, validate, projectItem, projectCursor)
      if (reply === null) log({ event: invalidEvent, peerKey: handle.peerKey })
    } catch (err) {
      log({ event: failedEvent, peerKey: handle.peerKey, error: err && err.message })
    }
    if (ch !== channel || ended || dropped) return
    answering = false
    rawSend(reply || emptyPage())
  }

  // ---- member role ----

  function onmember (msg) {
    if (msg.type === 'challenge') {
      if (challengeSeen) {
        badMessage()
        return
      }
      challengeSeen = true
      answerChallenge(msg.nonce)
      return
    }
    if (msg.type === 'items') {
      const r = request
      if (r === null || !r.sent) {
        badMessage() // never asked for
        return
      }
      request = null
      clearTimeout(r.timer)
      // A fresh copy from JSON.parse, already validated.
      r.resolve({ items: msg.items, next: msg.next, incomplete: msg.incomplete })
      return
    }
    badMessage() // proof or page: the seeder never sends these
  }

  function answerChallenge (nonceHex) {
    if (!socket.publicKey) {
      settleProved(false, new Error('no noise key'))
      close()
      return
    }
    // Our own Noise key: the seeder sees it as remotePublicKey.
    const signed = payload(nonceHex, hex(socket.publicKey), ownKey)
    let sig
    try {
      sig = sign(signed)
      if (!(sig instanceof Uint8Array) || sig.byteLength !== 64) throw new Error('invalid signature')
    } catch (err) {
      // E.g. the identity is locked: no proof, close the channel only.
      log({ event: 'notices-sign-failed', peerKey: handle.peerKey })
      settleProved(false, err)
      close()
      return
    }
    if (!rawSend({ type: 'proof', key: ownKey, sig: hex(sig) })) return
    settleProved(true)
    if (request !== null && !request.sent) sendRequest()
  }

  // One page in flight at a time; the page is sent only after our proof
  // (a page before it is bad on the seeder). The timeout runs from the call
  // and is terminal: it rejects AND closes the channel (the socket stays),
  // so a late reply cannot be mistaken for a later request's answer.
  function requestPage ({ after = null, limit = NOTICES_LIMIT_DEFAULT } = {}) {
    if (ended || dropped) return Promise.reject(new Error('notices channel closed'))
    if (request !== null) return Promise.reject(new Error('a notices page is already in flight'))
    const msg = { type: 'page', after, limit }
    if (!validate(msg)) return Promise.reject(new TypeError('invalid page request'))
    return new Promise((resolve, reject) => {
      const r = { msg, sent: false, resolve, reject, timer: null }
      r.timer = setTimeout(() => {
        if (request !== r) return
        request = null
        reject(new Error('notices page timed out'))
        close()
      }, requestTimeoutMs)
      // Not unref'd: a caller awaiting a page holds the loop until the
      // reply or the timeout (bounded, and cleared on either).
      request = r
      if (provedDone && isOpen) sendRequest()
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

// 'varanda/notices/2': the same flow with kinded items and seq cursors
// (notices-v2.js). Its own slot, drop reason and log events, so a v2 peer
// never disturbs the v1 channel on the same socket.
function attachNoticesV2 (socket, opts = {}) {
  return attachNotices(socket, {
    ...opts,
    protocol: NOTICES_V2_PROTOCOL,
    validate: validateNoticesV2Message,
    payload: noticeV2Payload,
    verify: verifyNoticeV2Proof,
    projectItem: projectItemV2,
    projectCursor: projectCursorV2,
    slot: '_varandaNoticesV2',
    dropReason: 'notices-v2',
    invalidEvent: 'notices-v2-page-invalid',
    failedEvent: 'notices-v2-page-failed'
  })
}

module.exports = {
  PROTOCOL,
  NOTICES_V2_PROTOCOL,
  MAX_NOTICES_MESSAGE,
  MAX_BAD_NOTICES,
  NOTICES_REQUEST_TIMEOUT_MS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  attachNotices,
  attachNoticesV2
}
