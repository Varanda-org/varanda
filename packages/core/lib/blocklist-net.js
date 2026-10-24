'use strict'

// Browser-safe blocklist channel: 'varanda/blocklist/1' on the protomux that
// the hypercore replication stream already put in socket.noiseStream.userData
// (the same muxer the admission channel uses, admission.js:173-176). Peers
// exchange the ordering key of the signed moderation snapshot they hold
// ({ type: 'have', moderatorDate, seq, sig }) and the side holding the newer
// one sends it ({ type: 'snapshot', snapshot }). `sig` is the first 32 hex
// characters of the held snapshot's `signature` ('' when none): it takes no
// part in the ordering, but lets a peer tell two different snapshots with the
// same (moderatorDate, seq) apart (e.g. the publisher in apps/cli
// mod-publish.js after an operator restored an old backup of the moderation
// dir). Verification, the ordering rule
// and persistence are injected (`offer`, `current`, `compare`), so this module
// needs only b4a, compact-encoding and ./clock: no blocklist.js, no hypercore,
// no hyperswarm, no node: builtins beyond what ./clock already uses.
//
// Flow control by credit: a `have` is a credit for ONE snapshot from the
// side that receives it. Each side counts the haves it sent on this
// connection (including the one on open) and the snapshots it received; a
// snapshot that arrives when snapshotsReceived >= havesSent was never asked
// for and counts as one bad message (it is discarded, never offered). The
// sender keeps one credit at most: a received valid have sets it, sending a
// snapshot spends it. The receiver sends a have after every processed
// verdict except a peer-fault one (adopted, 'same', 'stale': an honest sender
// learns our real key and regains its credit), nothing after a local failure
// until its retry resolves, and announce() sends one too. So the snapshots in
// flight toward us never exceed the haves we sent, whatever the timing: seven
// moderator publishes bunched together after a suspension (a phone PWA in the
// background, network buffering) reach us as at most one snapshot per credit
// we granted, and arrival time is never judged.
//
// Incoming snapshots: one PENDING slot per connection. A snapshot is offered
// at most once per minIntervalMs and never while another offer from this
// connection is in flight; one that arrives early is held in the slot (a
// newer credited arrival replaces the held one, which is honest) and offered
// when the interval has elapsed. An offer that fails locally (storage) keeps
// the snapshot in the slot and retries it with exponential backoff
// (minIntervalMs, doubling, capped at MAX_RETRY_DELAY_MS) for as long as the
// connection lives: the sender never resends a key on a connection.
//
// Message rate: one per-connection token bucket (MESSAGE_BURST tokens,
// refilled at MESSAGE_RATE per second from the monotonic ./clock, so time
// spent suspended refills it) over EVERY message received, checked before
// JSON.parse; a peer out of tokens is dropped with reason 'message-rate'.
// A valid have larger than MAX_HAVE_BYTES (JSON padding) counts as bad.
//
// Compatibility: a node from before B2 does not know the protocol. protomux
// rejects an open it has neither an opened channel nor a `pair` handler for
// (_onopensession -> _requestSession -> _rejectSession,
// node_modules/protomux/index.js:705-757, :794-805), and our side then closes
// the local channel (_onrejectsession, :759-779). Unlike the admission
// channel (admission.js onchannelclose), that close never destroys the
// socket: `supported` resolves false and admission keeps working.
const b4a = require('b4a')
const c = require('compact-encoding')
const clock = require('./clock')

const PROTOCOL = 'varanda/blocklist/1'
// Same bound as MAX_SNAPSHOT_BYTES in blocklist.js (a valid snapshot of
// MAX_BLOCKED keys is far below it, so the message wrapper fits too).
const MAX_BLOCKLIST_MESSAGE = 393216
const MIN_SNAPSHOT_INTERVAL_MS = 10000 // incoming snapshot messages per connection
const MAX_BAD_BLOCKLIST = 5 // the maxBad-th bad message drops the peer
// Our own snapshot sends are spaced a quarter longer than the receiver's
// minimum, so network jitter never makes an honest send look too early.
const SEND_INTERVAL_MARGIN_DIVISOR = 4
// Longest wait between two retries of a held snapshot whose offer() failed.
const MAX_RETRY_DELAY_MS = 300000
// Per-connection message bucket (same shape as admission.js tokenBucket).
// An honest peer stays far under it: it sends a have on open, one per
// snapshot of ours it processed (paced by our sendIntervalMs and by its
// minIntervalMs) and one per adoption it announces (human-paced moderator
// publishes), and a snapshot only against a credit we granted. The burst
// absorbs a run of `mod block` commands and the backlog after a suspension:
// the bucket refills while the receiver is suspended but stops at the
// burst, so a connection that survives a suspension during which more than
// MESSAGE_BURST distinct moderation updates were announced is dropped; the
// reconnect's opening exchange then delivers the newest snapshot (nothing
// is lost). Uncredited snapshots and oversized haves are bad messages, so a
// large burst grants a flooder only small parses.
const MESSAGE_BURST = 512
const MESSAGE_RATE = 2 // tokens per second
// A have is { type, moderatorDate, seq, sig }: our own encoding is under
// 150 bytes even with an extended-year date, MAX_SAFE_INTEGER and a 32-hex
// sig; anything longer is padding.
const MAX_HAVE_BYTES = 256
// Length of the signature prefix a have carries (128 bits of the Ed25519
// signature: enough to tell two snapshots apart, short enough for the have).
const SIG_HEX_LENGTH = 32
const SIG_RE = /^[0-9a-f]{32}$/
// offer() verdicts that prove the peer sent garbage; 'same' and 'stale'
// (an honest peer racing another update) never count.
const BAD_REASONS = new Set(['malformed', 'bad-signature', 'bad-moderator-signature', 'untrusted-association'])

function noop () {}

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

// Same rule as records.js isCanonicalIso (inlined to keep this module's
// dependencies to b4a and compact-encoding).
function isCanonicalIso (s) {
  try {
    return typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
  } catch {
    return false
  }
}

function validateBlocklistMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'have':
        return hasExactKeys(msg, ['type', 'moderatorDate', 'seq', 'sig']) &&
          (msg.moderatorDate === '' || isCanonicalIso(msg.moderatorDate)) &&
          Number.isSafeInteger(msg.seq) && msg.seq >= 0 &&
          typeof msg.sig === 'string' && (msg.sig === '' || SIG_RE.test(msg.sig)) &&
          (msg.moderatorDate !== '' || msg.sig === '')
      case 'snapshot':
        return hasExactKeys(msg, ['type', 'snapshot']) && isPlainObject(msg.snapshot)
      default:
        return false
    }
  } catch {
    return false
  }
}

// The ordering key of a snapshot (or of no snapshot: '', 0 and ''), plus
// the `sig` prefix that identifies its contents (ignored by the ordering).
function haveOf (snapshot) {
  if (!snapshot) return { moderatorDate: '', seq: 0, sig: '' }
  return { moderatorDate: snapshot.moderatorDate, seq: snapshot.seq, sig: sigOf(snapshot) }
}

// First SIG_HEX_LENGTH hex characters of a snapshot's signature, '' when it
// has none in the expected form (a held snapshot was verified, so this is
// only defence in depth: a have of ours is never invalid).
function sigOf (snapshot) {
  const s = snapshot && typeof snapshot.signature === 'string' ? snapshot.signature.slice(0, SIG_HEX_LENGTH) : ''
  return SIG_RE.test(s) ? s : ''
}

// Token bucket (inlined copy of admission.js tokenBucket, take() only, to
// keep this module's dependencies as they are): `burst` tokens, refilled
// lazily at `rate` per second on the monotonic clock.
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

// Default comparator over { moderatorDate, seq }: the total order
// blocklist.js acceptSnapshot uses (a newer moderator certificate wins, then
// the higher seq). Callers may inject blocklist.js compareSnapshots instead;
// it is always called with two { moderatorDate, seq, sig } objects and
// must ignore sig (two haves differing only in sig are equal in the order).
function compareHave (a, b) {
  const da = a.moderatorDate === '' ? -Infinity : Date.parse(a.moderatorDate)
  const db = b.moderatorDate === '' ? -Infinity : Date.parse(b.moderatorDate)
  if (da !== db) return da < db ? -1 : 1
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1
  return 0
}

function attachBlocklist (socket, opts = {}) {
  if (socket && socket._varandaBlocklist) return socket._varandaBlocklist

  const {
    current,
    offer,
    compare = compareHave,
    onhave = noop,
    log = noop,
    maxBytes = MAX_BLOCKLIST_MESSAGE,
    minIntervalMs = MIN_SNAPSHOT_INTERVAL_MS,
    maxBad = MAX_BAD_BLOCKLIST,
    messageBurst = MESSAGE_BURST,
    messageRate = MESSAGE_RATE
  } = opts

  if (typeof current !== 'function') throw new TypeError('current must be a function')
  if (typeof offer !== 'function') throw new TypeError('offer must be a function')
  if (typeof compare !== 'function') throw new TypeError('compare must be a function')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes')
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new TypeError('invalid minIntervalMs')
  if (!Number.isSafeInteger(maxBad) || maxBad < 1) throw new TypeError('invalid maxBad')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid message rate limits')

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachBlocklist')

  const sendIntervalMs = minIntervalMs + Math.ceil(minIntervalMs / SEND_INTERVAL_MARGIN_DIVISOR)
  // First retry delay; a zero interval still yields between retries.
  const retryBaseMs = Math.max(minIntervalMs, 1)

  let channel = null
  let message = null
  let isOpen = false
  let ended = false
  let dropped = false
  let settled = false
  let resolveSupported
  let lastSnapshotIn = -Infinity // when the last offer() of this connection started
  let lastSnapshotOut = -Infinity
  let sendTimer = null
  // The pending slot (see the header): the held snapshot, the earliest time
  // it may be offered and the next retry delay.
  let pending = null
  let pendingNotBefore = -Infinity
  let retryDelayMs = retryBaseMs
  let pendingTimer = null
  let offering = false // an offer() from this connection is in flight
  // Ordering keys already sent to this peer: one snapshot per peer per key.
  const sent = new Set()
  // Flow control (header): haves we sent and snapshots we received on the
  // current channel, and our credit (0 or 1) to send the peer a snapshot.
  let havesSent = 0
  let snapshotsReceived = 0
  let credit = 0
  const inbound = tokenBucket(messageBurst, messageRate)

  const handle = {
    peerKey: socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null,
    socket,
    remoteHave: null, // the peer's last valid have, { moderatorDate, seq, sig }
    badMessages: 0,
    supported: new Promise((resolve) => { resolveSupported = resolve }),
    announce,
    send: announce,
    close
  }
  socket._varandaBlocklist = handle

  // Whichever side opens first is paired: our own open below covers a peer
  // that opens later, and the pair handler covers a peer whose open arrives
  // when we hold no outgoing channel (e.g. it attached after rejecting ours).
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
    havesSent = 0
    snapshotsReceived = 0
    credit = 0
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
    sendHave()
    maybeSendSnapshot()
  }

  // A close before the open completed is the remote rejecting our open (an
  // old peer) or the transport going away: either way the peer does not
  // speak the protocol on this connection. The socket is left alone.
  function onchannelclose (isRemote, ch) {
    if (ch !== channel) return
    const wasOpen = isOpen
    isOpen = false
    channel = null
    message = null
    clearSendTimer()
    if (!wasOpen) settle(false)
  }

  function end () {
    if (ended) return
    ended = true
    clearSendTimer()
    clearPendingTimer()
    pending = null
    mux.unpair({ protocol: PROTOCOL })
    settle(false)
  }

  function close () {
    const ch = channel
    end()
    if (ch !== null) ch.close()
  }

  function clearSendTimer () {
    if (sendTimer) clearTimeout(sendTimer)
    sendTimer = null
  }

  function clearPendingTimer () {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
  }

  function rawSend (msg) {
    if (!isOpen || message === null) return false
    message.send(b4a.from(JSON.stringify(msg), 'utf8'))
    return true
  }

  // Every have we send grants the peer one snapshot (header).
  function sendHave () {
    const h = haveOf(current())
    if (!rawSend({ type: 'have', moderatorDate: h.moderatorDate, seq: h.seq, sig: h.moderatorDate === '' ? '' : h.sig })) return false
    havesSent++
    return true
  }

  // Tells the peer our current key and pushes our snapshot when the peer is
  // known to hold an older one. Called by the node after it adopts a
  // snapshot from another connection (fan-out).
  function announce () {
    if (ended || dropped || !isOpen) return false
    sendHave()
    maybeSendSnapshot()
    return true
  }

  function maybeSendSnapshot () {
    if (ended || dropped || !isOpen || handle.remoteHave === null || credit !== 1) return
    const snapshot = current()
    if (!snapshot) return
    const own = haveOf(snapshot)
    if (compare(own, handle.remoteHave) <= 0) return
    const key = own.moderatorDate + '|' + own.seq
    if (sent.has(key)) return
    const wait = lastSnapshotOut + sendIntervalMs - clock.now()
    if (wait > 0) {
      if (!sendTimer) {
        sendTimer = setTimeout(() => {
          sendTimer = null
          maybeSendSnapshot()
        }, Math.ceil(wait))
        if (sendTimer.unref) sendTimer.unref()
      }
      return
    }
    sent.add(key)
    const buf = b4a.from(JSON.stringify({ type: 'snapshot', snapshot }), 'utf8')
    if (buf.byteLength > maxBytes) {
      // The receiver would count it as bad; never send it.
      log({ event: 'blocklist-too-large', peerKey: handle.peerKey })
      return
    }
    lastSnapshotOut = clock.now()
    credit = 0
    message.send(buf)
  }

  function drop (reason) {
    if (dropped || ended) return
    dropped = true
    clearSendTimer()
    clearPendingTimer()
    pending = null
    log({ event: 'peer-dropped', peerKey: handle.peerKey, reason })
    socket.destroy()
  }

  function badMessage () {
    handle.badMessages++
    if (handle.badMessages >= maxBad) drop('blocklist')
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
    if (!validateBlocklistMessage(msg)) {
      badMessage()
      return
    }

    if (msg.type === 'have') {
      if (buf.byteLength > MAX_HAVE_BYTES) {
        badMessage() // padded: ignored, grants no credit
        return
      }
      credit = 1
      handle.remoteHave = { moderatorDate: msg.moderatorDate, seq: msg.seq, sig: msg.sig }
      try {
        onhave(handle.remoteHave, handle)
      } catch {}
      maybeSendSnapshot()
      return
    }

    // A snapshot we never asked for (no have of ours left to spend on it).
    if (snapshotsReceived >= havesSent) {
      badMessage()
      return
    }
    snapshotsReceived++
    holdSnapshot(msg.snapshot)
  }

  // Puts a snapshot in the pending slot and offers it as soon as the rules
  // allow (at once when the interval has elapsed and nothing is in flight).
  // It was credited, so replacing a held one is an honest newer update.
  function holdSnapshot (snapshot) {
    pending = snapshot
    pendingNotBefore = lastSnapshotIn + minIntervalMs
    retryDelayMs = retryBaseMs // a newer arrival resets the backoff
    schedulePending()
  }

  function schedulePending () {
    clearPendingTimer()
    if (ended || dropped || pending === null || offering) return
    const wait = pendingNotBefore - clock.now()
    if (wait <= 0) {
      offerPending()
      return
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      schedulePending()
    }, Math.ceil(wait))
    if (pendingTimer.unref) pendingTimer.unref()
  }

  // Not awaited by protomux: a rejected promise there destroys the stream,
  // and the offer may wait on the node's write queue.
  async function offerPending () {
    // The slot is emptied for the offer's duration: an arrival meanwhile is
    // held (not a replacement), and the offer's outcome decides what is kept.
    const snapshot = pending
    pending = null
    offering = true
    lastSnapshotIn = clock.now()
    let result = null
    let failed = false
    try {
      result = await offer(snapshot)
    } catch {
      failed = true
    }
    offering = false
    if (ended || dropped) return
    if (failed) {
      // A local failure (e.g. storage) is not the peer's fault: put the
      // snapshot back and retry it later, unless a newer one arrived.
      log({ event: 'blocklist-offer-failed', peerKey: handle.peerKey })
      if (pending === null) {
        pending = snapshot
        pendingNotBefore = clock.now() + retryDelayMs
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
      }
      schedulePending()
      return
    }
    if (!(result && result.adopted === true) && BAD_REASONS.has(result && result.reason)) {
      badMessage() // a peer fault: no have, so no new credit
    } else {
      // Adopted, 'same' or 'stale': tell the peer our real key, which also
      // grants it the credit for its next (newer) snapshot.
      sendHave()
    }
    schedulePending()
  }
}

module.exports = {
  PROTOCOL,
  MAX_BLOCKLIST_MESSAGE,
  MIN_SNAPSHOT_INTERVAL_MS,
  MAX_BAD_BLOCKLIST,
  SEND_INTERVAL_MARGIN_DIVISOR,
  MAX_RETRY_DELAY_MS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  MAX_HAVE_BYTES,
  SIG_HEX_LENGTH,
  BAD_REASONS,
  validateBlocklistMessage,
  compareHave,
  haveOf,
  attachBlocklist
}
