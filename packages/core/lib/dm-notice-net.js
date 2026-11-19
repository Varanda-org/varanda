'use strict'

// The 'varanda/dm-notice/1' channel, on the protomux of the same stream as
// the DM lanes (dm-net.js). After a put, the member asks the seeder to pass
// a sealed notice (dm-notice.js) for that drop to the account service:
//
//   member -> seeder  { type: 'wake', id, box }   id: drop id, 64 lowercase hex
//                                                 box: base64, DM_NOTICE_BOX_BYTES
//   seeder -> member  { type: 'ack' }
//
// The seeder answers every well-formed wake with the same ack, whether it
// stored that drop or not, so the member learns nothing about the pool. It
// hands the box on (onWake) only when its window takes the id: one wake per
// drop it stored recently. It never opens the box and sends no key. The
// window belongs to the caller; it should be the one of the link that put
// the drop, so another member who read a drop id from the pool cannot spend
// that drop's wake.
//
// Bad messages: a frame over maxBytes, a JSON or shape failure (missing or
// extra keys, a wrong type, an id or box of the wrong form), a message of
// the other role, and on the member an ack nobody waits for. More than
// maxBad of them, or a flood over the message rate, closes the channel for
// the rest of the socket (unpaired, so a reopen is refused); the socket
// itself stays, it carries the DM lanes.
//
// The member never repeats a wake. notice() resolves false on a timeout, a
// closed channel or a seeder from before this channel (its mux refuses the
// open, so that is known at once). A timeout is terminal for the channel, as
// in dm-net.js: acks carry no id, so a late one must not answer a later wake.
const b4a = require('b4a')
const c = require('compact-encoding')
const clock = require('./clock')
const { hasExactKeys } = require('./records')
const { DM_NOTICE_BOX_BYTES } = require('./dm-notice')

const DM_NOTICE_PROTOCOL = 'varanda/dm-notice/1'
const MAX_BAD_DM_NOTICE = 5
const DM_NOTICE_TIMEOUT_MS = 3000
const DM_NOTICE_MAX_MESSAGE = 512
const DM_NOTICE_MESSAGE_BURST = 32
const DM_NOTICE_MESSAGE_RATE = 8 // tokens per second
const DM_NOTICE_MAX_PENDING = 8
const SLOT = '_varandaDmNotice'
const WAKE_KEYS = Object.freeze(['type', 'id', 'box'])
const ACK_KEYS = Object.freeze(['type'])
const ID_HEX = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BOX_BASE64_LENGTH = Math.ceil(DM_NOTICE_BOX_BYTES / 3) * 4

function noop () {}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
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

// Only the canonical base64 of exactly DM_NOTICE_BOX_BYTES bytes: a lenient
// decoder would let two frames name the same box.
function isBoxBase64 (s) {
  if (typeof s !== 'string' || s.length !== BOX_BASE64_LENGTH || !BASE64.test(s)) return false
  const bytes = b4a.from(s, 'base64')
  return bytes.byteLength === DM_NOTICE_BOX_BYTES && b4a.toString(bytes, 'base64') === s
}

function validateNoticeMessage (msg) {
  if (!isPlainObject(msg)) return false
  if (msg.type === 'wake') return hasExactKeys(msg, WAKE_KEYS) && typeof msg.id === 'string' && ID_HEX.test(msg.id) && isBoxBase64(msg.box)
  if (msg.type === 'ack') return hasExactKeys(msg, ACK_KEYS)
  return false
}

// A drop id as decodeDrop gives it (32 bytes) or as the pool keys it (hex).
function wireId (id) {
  if (typeof id === 'string') return ID_HEX.test(id) ? id : null
  if (id instanceof Uint8Array && id.byteLength === 32) return b4a.toString(id, 'hex')
  return null
}

function attachDmNotice (socket, opts = {}) {
  const {
    role,
    window,
    onWake,
    log = noop,
    maxBad = MAX_BAD_DM_NOTICE,
    maxBytes = DM_NOTICE_MAX_MESSAGE,
    messageBurst = DM_NOTICE_MESSAGE_BURST,
    messageRate = DM_NOTICE_MESSAGE_RATE,
    maxPending = DM_NOTICE_MAX_PENDING
  } = opts

  if (role !== 'seeder' && role !== 'member') throw new TypeError('role must be seeder or member')
  if (role === 'seeder') {
    if (!window || typeof window.take !== 'function') throw new TypeError('window must have take()')
    if (typeof onWake !== 'function') throw new TypeError('onWake must be a function')
  }
  if (typeof log !== 'function') throw new TypeError('invalid log')
  if (!Number.isSafeInteger(maxBad) || maxBad < 0) throw new TypeError('invalid maxBad')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid rate limits')
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('invalid maxPending')

  if (socket && socket[SLOT]) {
    if (socket[SLOT].role !== role) throw new TypeError('slot in use by another role')
    return socket[SLOT]
  }

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachDmNotice')

  const protocol = DM_NOTICE_PROTOCOL
  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let settled = false
  let resolveSupported
  const inbound = tokenBucket(messageBurst, messageRate)
  // Member: wakes waiting for their ack, in the order sent.
  const pending = []

  const handle = {
    socket,
    role,
    protocol,
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    close
  }
  if (role === 'member') handle.notice = notice
  socket[SLOT] = handle

  mux.pair({ protocol }, onpair)
  openChannel()

  return handle

  function settle (value) {
    if (settled) return
    settled = true
    resolveSupported(value)
  }

  function openChannel () {
    const ch = mux.createChannel({ protocol, onopen, onclose: onchannelclose })
    if (ch === null) return
    channel = ch
    message = ch.addMessage({ encoding: c.buffer, onmessage: onraw })
    ch.open()
  }

  function onpair () {
    if (ended || channel !== null) return
    openChannel()
  }

  function onopen (handshake, ch) {
    if (ch !== channel || ended) return
    isOpen = true
    settle(true)
    flush()
  }

  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    if (!wasOpen) settle(false)
    // A dead socket needs no pairing; the member has nothing to wait for.
    if (role === 'member' || socket.destroyed === true || socket.destroying === true) end()
  }

  function end () {
    if (ended) return
    ended = true
    mux.unpair({ protocol })
    settle(false)
    failPending()
    if (socket[SLOT] === handle) delete socket[SLOT]
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

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages > maxBad) {
      log({ event: 'dm-notice-closed', reason: 'bad' })
      close()
    }
  }

  function onraw (buf) {
    if (ended) return
    if (!inbound.take()) {
      log({ event: 'dm-notice-closed', reason: 'message-rate' })
      close()
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
    if (!validateNoticeMessage(msg)) {
      badMessage()
      return
    }
    if (role === 'seeder') onseeder(msg)
    else onmember(msg)
  }

  // ---- seeder role ----

  function onseeder (msg) {
    if (msg.type !== 'wake') {
      badMessage()
      return
    }
    // The ack goes first and is the same for every wake: whether the window
    // knows the id must not show in the reply.
    rawSend({ type: 'ack' })
    let taken = false
    try {
      taken = window.take(msg.id) === true
    } catch {
      taken = false
    }
    if (!taken) return
    try {
      const r = onWake(b4a.from(msg.box, 'base64'))
      if (r && typeof r.then === 'function') r.then(noop, noop)
    } catch {}
  }

  // ---- member role ----

  function onmember (msg) {
    if (msg.type !== 'ack' || pending.length === 0 || !pending[0].sent) {
      badMessage()
      return
    }
    finish(pending.shift(), true)
  }

  function notice (id, box, options) {
    return new Promise((resolve) => {
      let r = null
      try {
        const timeoutMs = options && options.timeoutMs !== undefined ? options.timeoutMs : DM_NOTICE_TIMEOUT_MS
        const idHex = wireId(id)
        if (idHex === null || !(box instanceof Uint8Array) || box.byteLength !== DM_NOTICE_BOX_BYTES) return resolve(false)
        if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return resolve(false)
        if (ended || pending.length >= maxPending) return resolve(false)
        r = { msg: { type: 'wake', id: idHex, box: b4a.toString(box, 'base64') }, sent: false, done: false, resolve, timer: null }
        r.timer = setTimeout(ontimeout, timeoutMs, r)
        pending.push(r)
        if (isOpen) flush()
      } catch {
        if (r !== null) finish(r, false)
        else resolve(false)
      }
    })
  }

  function ontimeout (r) {
    if (r.done) return
    finish(r, false)
    close()
  }

  function flush () {
    for (const r of pending) {
      if (r.sent) continue
      if (!rawSend(r.msg)) return
      r.sent = true
    }
  }

  function finish (r, value) {
    if (r.done) return
    r.done = true
    clearTimeout(r.timer)
    const i = pending.indexOf(r)
    if (i !== -1) pending.splice(i, 1)
    r.resolve(value)
  }

  function failPending () {
    while (pending.length > 0) finish(pending[0], false)
  }
}

module.exports = {
  DM_NOTICE_PROTOCOL,
  MAX_BAD_DM_NOTICE,
  DM_NOTICE_TIMEOUT_MS,
  DM_NOTICE_MAX_MESSAGE,
  DM_NOTICE_MESSAGE_BURST,
  DM_NOTICE_MESSAGE_RATE,
  DM_NOTICE_MAX_PENDING,
  validateNoticeMessage,
  attachDmNotice
}
