// Browser-safe admission protocol: the 'varanda/admission/1' channel (sharing
// the hypercore replication muxer) with its limits and validation (docs §4,
// §5, §8). Requires only b4a, compact-encoding, hypercore-crypto, ./records
// and ./clock, so a browser bundle can reuse it without loading hypercore,
// hyperdht, hyperswarm or node:fs. lib/net.js re-exports every name here.
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { MAX_LOG_BLOCKS } = require('./records')
const clock = require('./clock')

const PROTOCOL = 'varanda/admission/1'
const MAX_PAYLOAD = 16384
const MAX_HELLO_HAVE = 100
const INVENTORY_TIMEOUT_MS = 5000
// Per-connection limits (security audit S1, S6): a peer that exceeds one is
// disconnected and logged as { event: 'peer-dropped', peerKey, reason }.
const MAX_INVENTORY = 4096 // distinct keys one peer may advertise
const MAX_BAD_MESSAGES = 16 // tolerated per connection; one more disconnects
const HELLO_TIMEOUT_MS = 10000 // a valid hello must arrive within this
const MAX_CONNECTIONS = 64 // open connections per swarm (server side too)
// Open sockets one quarantine fetch may hold at once (CWE-770).
const MAX_FETCH_ATTACHMENTS = MAX_CONNECTIONS
// Message rate (cycle 3 H1, CWE-770): a per-connection token bucket over
// every VALID admission message. The burst covers an honest initial
// inventory (hello + up to MAX_INVENTORY overflow have messages) with room to
// spare; a peer over it is dropped with reason 'message-rate'.
const MESSAGE_BURST = MAX_INVENTORY + 64
const MESSAGE_RATE = 100 // tokens per second
// Our own sends are paced below the receiver's bucket (same burst minus a
// margin for network jitter, half the rate), and queued have and rejected
// messages are coalesced per key (latest wins), so an honest peer that
// advertises growth block by block (watchContiguous) never trips the
// receiver's limit.
const SEND_RATE_DIVISOR = 2
const SEND_BURST_MARGIN_DIVISOR = 16
// Bound on our own queued sends per connection (cycle 3 retry, item 3): per
// key, at most one have and one rejected are queued (merged, see pacedSend),
// so a full inventory of haves plus a rejected per key fits; other messages
// count one each. An overflow drops the peer with reason 'send-backlog'.
const MAX_SEND_BACKLOG = 2 * MAX_INVENTORY + 64

const HEX64 = /^[0-9a-f]{64}$/
const HEX64_ANY = /^[0-9a-fA-F]{64}$/
// A rejected.reason is a token, never free text (S4).
const REASON_RE = /^[a-z0-9-]{1,64}$/

function noop () {}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

// Advertised lengths are capped at MAX_LOG_BLOCKS (S1): no log over the quota
// is ever kept, so a larger claim is a protocol violation.
function isLength (n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_LOG_BLOCKS
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  if (own.length !== keys.length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  }
  return true
}

function topicFor (associationHex) {
  if (typeof associationHex !== 'string' || !HEX64_ANY.test(associationHex)) {
    throw new TypeError('associationHex must be 64 hex characters')
  }
  return crypto.hash(b4a.from('varanda/rendezvous/v1:' + associationHex.toLowerCase(), 'utf8'))
}

function validateHaveEntry (e) {
  return isPlainObject(e) && hasExactKeys(e, ['key', 'length']) && isHex64(e.key) && isLength(e.length)
}

function validateMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'hello': {
        const isSeeder = msg.role === 'seeder'
        if (!isSeeder && msg.role !== 'member') return false
        const keys = ['type', 'v', 'role', 'count', 'have']
        if (isSeeder) keys.push('cert')
        if (!hasExactKeys(msg, keys)) return false
        if (msg.v !== 1) return false
        if (isSeeder && !isPlainObject(msg.cert)) return false
        if (!Array.isArray(msg.have) || msg.have.length > MAX_HELLO_HAVE) return false
        if (!Number.isSafeInteger(msg.count) || msg.count < msg.have.length) return false
        if (msg.count > MAX_INVENTORY) return false
        return msg.have.every(validateHaveEntry)
      }
      case 'have':
      case 'admitted':
        return hasExactKeys(msg, ['type', 'key', 'length']) && isHex64(msg.key) && isLength(msg.length)
      case 'announce':
        return hasExactKeys(msg, ['type', 'key', 'cert']) && isHex64(msg.key) && isPlainObject(msg.cert)
      case 'rejected':
        return hasExactKeys(msg, ['type', 'key', 'reason']) && isHex64(msg.key) &&
          typeof msg.reason === 'string' && REASON_RE.test(msg.reason)
      default:
        return false
    }
  } catch {
    return false
  }
}

// Token bucket: `burst` tokens, refilled at `rate` per second, on a
// monotonic clock (a wall-clock step must not drain or stall it). take()
// consumes one token when available; force(n) consumes n even into debt (our
// own initial inventory, which the receiver's burst is sized for); waitMs()
// is the time until one token is available.
function tokenBucket (burst, rate) {
  let tokens = burst
  let last = clock.now()
  function refill () {
    const now = clock.now()
    tokens = Math.min(burst, tokens + (now - last) * rate / 1000)
    last = now
  }
  return {
    take () {
      refill()
      if (tokens < 1) return false
      tokens--
      return true
    },
    force (n) {
      refill()
      tokens -= n
    },
    waitMs () {
      refill()
      return tokens >= 1 ? 0 : Math.ceil((1 - tokens) * 1000 / rate)
    }
  }
}

function attachAdmission (socket, opts = {}) {
  if (socket._varandaPeer) return socket._varandaPeer

  const {
    role,
    cert = null,
    have = [],
    onmessage = noop,
    onclose = noop,
    oninventory = noop,
    log = noop,
    helloTimeoutMs = HELLO_TIMEOUT_MS, // injectable for tests
    messageBurst = MESSAGE_BURST, // injectable for tests
    messageRate = MESSAGE_RATE // injectable for tests
  } = opts

  if (role !== 'member' && role !== 'seeder') throw new TypeError('role must be member or seeder')
  if (role === 'seeder' && !isPlainObject(cert)) throw new TypeError('seeder role requires cert')
  if (!Array.isArray(have) || !have.every(validateHaveEntry)) throw new TypeError('invalid have entries')
  // Never send a hello the receiver rejects (count > MAX_INVENTORY).
  if (have.length > MAX_INVENTORY) throw new TypeError('inventory over MAX_INVENTORY')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid message rate limits')

  const mux = socket && socket.noiseStream && socket.noiseStream.userData && socket.noiseStream.userData.isProtomux
    ? socket.noiseStream.userData
    : null
  if (!mux) throw new Error('replicate the store before attachAdmission')

  let resolveOpened
  let resolveHello
  let isOpen = false
  let closed = false
  let closeNotified = false
  let inventoryTimer = null
  let helloTimer = null
  let gotHello = false
  let dropped = null // reason the socket was destroyed by a limit
  const inbound = tokenBucket(messageBurst, messageRate)
  const outbound = tokenBucket(
    Math.max(1, messageBurst - Math.ceil(messageBurst / SEND_BURST_MARGIN_DIVISOR)),
    messageRate / SEND_RATE_DIVISOR
  )
  // Paced outgoing messages, in order, as entries { msg, seq, live }. An
  // entry merged away is marked dead in place and skipped by the flush; the
  // array is compacted once dead entries outnumber live ones.
  let backlog = []
  let backlogLive = 0 // live entries in backlog
  let backlogSeq = 0
  // key -> { have, rejected }: the mergeable have/rejected entries for that
  // key queued since the last other message for it (admitted, announce),
  // which bounds how far a merge may move a message.
  const backlogTail = new Map()
  let flushTimer = null

  const peer = {
    peerKey: socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null,
    socket,
    role,
    remoteRole: null,
    remoteCert: null,
    remoteCount: null,
    remoteHave: new Map(),
    inventoryComplete: false,
    badMessages: 0,
    opened: new Promise((resolve) => { resolveOpened = resolve }),
    hello: new Promise((resolve) => { resolveHello = resolve }),
    send,
    close,
    queued: () => backlogLive // our sends waiting (test inspection)
  }

  const channel = mux.createChannel({ protocol: PROTOCOL, onopen, onclose: onchannelclose })
  if (channel === null) throw new Error('duplicate admission channel')

  const message = channel.addMessage({ encoding: c.buffer, onmessage: onraw })

  socket._varandaPeer = peer
  channel.open()
  // The hello timeout runs from here (the channel is opened at once): a
  // peer that never opens the channel is dropped too.
  helloTimer = setTimeout(() => {
    helloTimer = null
    if (!gotHello) drop('hello-timeout')
  }, helloTimeoutMs)
  if (helloTimer.unref) helloTimer.unref()

  return peer

  // A limit was exceeded (S1, S6): the socket is destroyed, which closes the
  // channel (onchannelclose settles the promises and notifies onclose).
  function drop (reason) {
    if (dropped || closed) return
    dropped = reason
    log({ event: 'peer-dropped', peerKey: peer.peerKey, reason })
    socket.destroy()
  }

  function badMessage () {
    peer.badMessages++
    if (peer.badMessages > MAX_BAD_MESSAGES) drop('bad-messages')
  }

  function rawSend (msg) {
    message.send(b4a.from(JSON.stringify(msg), 'utf8'))
  }

  function send (msg) {
    if (closed || !validateMessage(msg)) return false
    pacedSend(msg)
    return true
  }

  // Sends now when the channel is open, the outbound bucket allows and
  // nothing is waiting; otherwise queues in order (also before the channel
  // opens). Per key, since the last other message queued for it, at most one
  // have and one rejected are queued, in their relative order:
  // - a rejected replaces the queued have/rejected for its key, taking the
  //   position of the earliest one (or is appended when none is queued);
  // - a have updates the queued have's length when nothing for its key is
  //   queued after that have; otherwise (after a rejected) it is queued once.
  // Every other message (hello, admitted, announce) is queued as is and is
  // never merged or reordered. The queue is bounded.
  function pacedSend (msg) {
    const key = typeof msg.key === 'string' ? msg.key : null
    const tail = key === null ? null : backlogTail.get(key)
    if (msg.type === 'have') {
      if (tail && tail.have && (!tail.rejected || tail.rejected.seq < tail.have.seq)) {
        tail.have.msg.length = msg.length
        return
      }
    } else if (msg.type === 'rejected') {
      if (tail && (tail.have || tail.rejected)) {
        let first = tail.rejected || tail.have
        if (tail.have && tail.have.seq < first.seq) first = tail.have
        const other = first === tail.have ? tail.rejected : tail.have
        first.msg = { ...msg }
        if (other) killEntry(other)
        tail.rejected = first
        tail.have = null
        return
      }
    } else if (key !== null) {
      backlogTail.delete(key)
    }
    if (isOpen && backlogLive === 0 && outbound.take()) {
      rawSend(msg)
      return
    }
    if (backlogLive >= MAX_SEND_BACKLOG) {
      drop('send-backlog')
      return
    }
    const entry = { msg: { ...msg }, seq: backlogSeq++, live: true }
    backlog.push(entry)
    backlogLive++
    if (msg.type === 'have' || msg.type === 'rejected') {
      let t = tail
      if (!t) {
        t = { have: null, rejected: null }
        backlogTail.set(key, t)
      }
      t[msg.type] = entry
    }
    scheduleFlush()
  }

  function killEntry (entry) {
    entry.live = false
    backlogLive--
    if (backlog.length > 64 && backlog.length > 2 * backlogLive) {
      backlog = backlog.filter((e) => e.live)
    }
  }

  // An entry leaving the backlog leaves the merge map too.
  function untrackEntry (entry) {
    const key = entry.msg.key
    if (typeof key !== 'string') return
    const tail = backlogTail.get(key)
    if (!tail) return
    if (tail.have === entry) tail.have = null
    if (tail.rejected === entry) tail.rejected = null
    if (!tail.have && !tail.rejected) backlogTail.delete(key)
  }

  function flushBacklog () {
    flushTimer = null
    if (closed || !isOpen) return
    while (backlog.length > 0) {
      const entry = backlog[0]
      if (!entry.live) {
        backlog.shift()
        continue
      }
      if (!outbound.take()) break
      backlog.shift()
      backlogLive--
      untrackEntry(entry)
      rawSend(entry.msg)
    }
    if (backlogLive > 0) scheduleFlush()
  }

  function scheduleFlush () {
    if (flushTimer || closed || !isOpen) return
    flushTimer = setTimeout(flushBacklog, Math.max(1, outbound.waitMs()))
    if (flushTimer.unref) flushTimer.unref()
  }

  function close () {
    channel.close()
  }

  function onopen () {
    if (closed) return
    isOpen = true
    const hello = { type: 'hello', v: 1, role, count: have.length, have: have.slice(0, MAX_HELLO_HAVE) }
    if (role === 'seeder') hello.cert = cert
    rawSend(hello)
    const overflow = have.slice(MAX_HELLO_HAVE)
    for (const e of overflow) rawSend({ type: 'have', key: e.key, length: e.length })
    // The initial inventory fits the receiver's burst by construction.
    outbound.force(1 + overflow.length)
    // Sends made before the channel opened follow the inventory, paced.
    flushBacklog()
    resolveOpened(true)
  }

  // A channel that closes before it opened, or before a valid hello arrived,
  // settles the pending promises (opened -> false, hello -> null); they never
  // reject, so a caller awaiting them treats false/null as "peer gone".
  // The socket is destroyed with it (cycle 3 retry, item 1): a peer that
  // closes only the admission channel must not keep the transport (and its
  // connection slot) without ever being subject to the hello timeout.
  function onchannelclose () {
    closed = true
    isOpen = false
    backlog = []
    backlogLive = 0
    backlogTail.clear()
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    clearInventoryTimer()
    if (helloTimer) clearTimeout(helloTimer)
    helloTimer = null
    resolveOpened(false)
    if (!gotHello) resolveHello(null)
    if (!socket.destroyed) socket.destroy()
    if (closeNotified) return
    closeNotified = true
    onclose(peer)
    // The advertised keys are per-connection state: release them so a
    // closed socket still referenced elsewhere (socket._varandaPeer) does
    // not pin up to MAX_INVENTORY entries.
    peer.remoteHave = new Map()
  }

  function clearInventoryTimer () {
    if (inventoryTimer) clearTimeout(inventoryTimer)
    inventoryTimer = null
  }

  function markInventoryComplete () {
    if (peer.inventoryComplete) return
    peer.inventoryComplete = true
    clearInventoryTimer()
    oninventory(peer)
  }

  function checkInventory () {
    if (gotHello && !peer.inventoryComplete && peer.remoteHave.size >= peer.remoteCount) {
      markInventoryComplete()
    }
  }

  // The (single) valid hello starts inventory tracking: a timer bounds the
  // wait for the overflow have messages that follow it.
  function startInventory () {
    peer.inventoryComplete = false
    clearInventoryTimer()
    if (closed) return
    inventoryTimer = setTimeout(() => {
      inventoryTimer = null
      if (peer.inventoryComplete || closed) return
      log({ event: 'inventory-timeout', peerKey: peer.peerKey })
      markInventoryComplete()
    }, INVENTORY_TIMEOUT_MS)
    if (inventoryTimer.unref) inventoryTimer.unref()
  }

  function onraw (buf) {
    if (closed || dropped) return
    let msg
    try {
      if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_PAYLOAD) {
        badMessage()
        return
      }
      msg = JSON.parse(b4a.toString(buf, 'utf8'))
    } catch {
      badMessage()
      return
    }
    if (!validateMessage(msg)) {
      badMessage()
      return
    }
    // Every valid message costs one token (H1): repeating a known
    // advertisement never grows remoteHave nor counts as bad, so it is
    // bounded here.
    if (!inbound.take()) {
      drop('message-rate')
      return
    }

    if (msg.type === 'hello') {
      // Exactly one hello per connection (S6): a second one is a protocol
      // violation (our side sends exactly one, in onopen).
      if (gotHello) {
        drop('duplicate-hello')
        return
      }
      peer.remoteRole = msg.role
      peer.remoteCert = msg.role === 'seeder' ? msg.cert : null
      peer.remoteCount = msg.count
      peer.remoteHave = new Map()
      for (const e of msg.have) peer.remoteHave.set(e.key, e.length)
      gotHello = true
      if (helloTimer) clearTimeout(helloTimer)
      helloTimer = null
      resolveHello(msg)
      startInventory()
      // The hello is dispatched BEFORE its inventory can complete, so the
      // caller has updated its per-peer state (role, verified seeder) by the
      // time oninventory fires for it.
      onmessage(msg, peer)
      checkInventory()
      return
    } else if (msg.type === 'have' || msg.type === 'admitted') {
      // Only seeders admit (S2): an admitted from any other role is a bad
      // message and never touches remoteHave.
      if (msg.type === 'admitted' && peer.remoteRole !== 'seeder') {
        badMessage()
        return
      }
      // Bounded per-peer state (S1): a new key beyond MAX_INVENTORY distinct
      // keys disconnects the peer; the map never exceeds the cap.
      if (!peer.remoteHave.has(msg.key) && peer.remoteHave.size >= MAX_INVENTORY) {
        drop('inventory-limit')
        return
      }
      peer.remoteHave.set(msg.key, msg.length)
      // Dispatched BEFORE the completion check (same rule as the hello), so
      // the caller has recorded this advertisement when oninventory fires.
      onmessage(msg, peer)
      checkInventory()
      return
    } else if (msg.type === 'rejected') {
      peer.remoteHave.delete(msg.key)
    }

    onmessage(msg, peer)
  }
}

module.exports = {
  PROTOCOL,
  MAX_PAYLOAD,
  MAX_HELLO_HAVE,
  INVENTORY_TIMEOUT_MS,
  MAX_INVENTORY,
  MAX_BAD_MESSAGES,
  HELLO_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_FETCH_ATTACHMENTS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  SEND_RATE_DIVISOR,
  SEND_BURST_MARGIN_DIVISOR,
  MAX_SEND_BACKLOG,
  HEX64,
  HEX64_ANY,
  REASON_RE,
  noop,
  isPlainObject,
  isHex64,
  isLength,
  hasExactKeys,
  topicFor,
  validateHaveEntry,
  validateMessage,
  tokenBucket,
  attachAdmission
}
