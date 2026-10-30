// Network helpers: bootstrap parsing, swarm creation, growth and fork
// watchers, and the quarantine block-0 fetch (docs §4, §5, §8). The
// 'varanda/admission/1' channel, rendezvous topic and message validation live
// in ./admission (browser-safe) and are re-exported here unchanged.
const b4a = require('b4a')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const admission = require('./admission')
const deletion = require('./deletion')
const {
  MAX_CONNECTIONS,
  MAX_FETCH_ATTACHMENTS,
  noop,
  isPlainObject
} = admission

function normalizeBootstrapEntry (host, port) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('invalid bootstrap entry: empty host')
  }
  const p = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new TypeError('invalid bootstrap entry: bad port')
  }
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return h + ':' + p
}

function parseBootstrapString (entry) {
  if (typeof entry !== 'string') throw new TypeError('invalid bootstrap entry')
  const s = entry.trim()
  const i = s.lastIndexOf(':')
  if (i <= 0) throw new TypeError('invalid bootstrap entry: ' + entry)
  return normalizeBootstrapEntry(s.slice(0, i), s.slice(i + 1))
}

function parseBootstrap (value) {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  let list
  if (typeof value === 'string') list = value.split(',')
  else if (Array.isArray(value)) list = value
  else throw new TypeError('invalid bootstrap value')
  return list.map((entry) => {
    if (isPlainObject(entry)) return normalizeBootstrapEntry(entry.host, entry.port)
    return parseBootstrapString(entry)
  })
}

function generateNoiseKeyPair () {
  return HyperDHT.keyPair()
}

function isLoopbackHost (host) {
  return host === '127.0.0.1' || host === '::1'
}

function createSwarm ({ bootstrap, keyPair, host } = {}) {
  // With a private bootstrap, port [0, 0] makes the DHT bind an ephemeral
  // port (hyperdht rewrites port 0 to 49737; an empty range falls through to
  // bind(0)). When the DHT is bound to a loopback address (tests, the demo,
  // same-machine manual runs) every node is directly reachable, so firewall
  // detection is switched off: with the default probing, a client-initiated
  // connection between two processes that both bound ephemeral ports opened
  // but carried no data until the other side reconnected (observed with
  // hyperdht 6.34 on loopback; the demo's sync --once then waited on the
  // seeder's rediscovery). A private bootstrap on any other host says nothing
  // about reachability (a peer behind NAT would fail), so hyperdht's own
  // detection stays on. swarm.destroy() also destroys this DHT, so never
  // destroy it separately.
  const dhtOpts = bootstrap ? { bootstrap, port: [0, 0] } : {}
  if (host) {
    dhtOpts.host = host
    if (isLoopbackHost(host)) dhtOpts.firewalled = false
  }
  // maxPeers bounds the connections hyperswarm initiates; it never reads
  // maxServerConnections, so incoming connections are bounded by
  // refuseOverConnectionLimit on every 'connection' instead.
  return new Hyperswarm({ keyPair, dht: new HyperDHT(dhtOpts), maxPeers: MAX_CONNECTIONS })
}

// Connection cap (S1), run on every swarm 'connection' BEFORE
// store.replicate: when the swarm already holds `limit` other open
// connections the new socket is destroyed, logged as
// { event: 'peer-dropped', peerKey, reason: 'connection-limit' }, and true is
// returned. The socket itself is already in swarm.connections when hyperswarm
// emits 'connection', so it is not counted against itself.
function refuseOverConnectionLimit (swarm, socket, { limit = MAX_CONNECTIONS, log = noop } = {}) {
  const connections = swarm && swarm.connections ? swarm.connections : new Set()
  const others = connections.size - (connections.has(socket) ? 1 : 0)
  if (others < limit) return false
  const peerKey = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null
  log({ event: 'peer-dropped', peerKey, reason: 'connection-limit' })
  socket.destroy()
  return true
}

async function joinAndFlush (swarm, topics) {
  const joined = new Set()
  const discoveries = []
  for (const topic of topics) {
    if (!b4a.isBuffer(topic) || topic.byteLength !== 32) {
      throw new TypeError('topic must be a 32-byte buffer')
    }
    const hex = b4a.toString(topic, 'hex')
    if (joined.has(hex)) continue
    const existing = swarm.status(topic)
    if (existing && !existing.destroyed) continue
    joined.add(hex)
    discoveries.push(swarm.join(topic, { server: true, client: true }))
  }
  for (const d of discoveries) await d.flushed()
  await swarm.flush()
}

// Re-runs the DHT lookup of every topic that still has no peer. Hyperswarm
// refreshes a discovery only every 10 minutes, so two swarms whose first join
// of a topic happens at the same moment (each looks up before the other's
// announce is stored) would otherwise not find each other for that long.
function startRediscovery (swarm, topics, { intervalMs = 1000, hasPeer = () => false, log = noop } = {}) {
  const list = []
  for (const topic of topics) {
    if (!b4a.isBuffer(topic) || topic.byteLength !== 32) {
      throw new TypeError('topic must be a 32-byte buffer')
    }
    list.push(topic)
  }
  let stopped = false
  const timer = setInterval(() => {
    if (stopped || swarm.destroyed) return
    for (const topic of list) {
      let has = false
      try {
        has = hasPeer(topic)
      } catch (err) {
        log({ event: 'rediscovery-error', topic: b4a.toString(topic, 'hex'), error: err.message })
        continue
      }
      if (has) continue
      const discovery = swarm.status(topic)
      if (!discovery || discovery.destroyed) continue
      try {
        const p = discovery.refresh()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => log({ event: 'rediscovery-error', topic: b4a.toString(topic, 'hex'), error: err.message }))
        }
      } catch (err) {
        log({ event: 'rediscovery-error', topic: b4a.toString(topic, 'hex'), error: err.message })
      }
    }
  }, intervalMs)
  if (timer.unref) timer.unref()
  return function stop () {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

function watchContiguous (core, onGrow) {
  let last = core.contiguousLength
  const check = () => {
    const len = core.contiguousLength
    if (len > last) {
      last = len
      onGrow(len)
    }
  }
  core.on('append', check)
  core.on('download', check)
  return function stop () {
    core.off('append', check)
    core.off('download', check)
  }
}

// watchContiguous for a diary with cleared blocks: a clear pulls
// contiguousLength back, so growth is measured on the present length
// (lib/deletion.js) with getDeleted() as the current deleted set. Also
// fires on a downloaded tombstone even without growth, since a tombstone
// above an unknown hole is what lets the present length move past it.
// The length is advanced from the last value; a deleted set that lost a
// seq (an undone deletion) restarts the walk from 0. onGrow is awaited, and
// a deleted set that changed during the pass (onGrow often adds a new
// tombstone's target) walks again, since no event may follow.
function watchPresent (core, getDeleted, onGrow) {
  let last = -1
  let from = 0
  let seen = new Set()
  let stopped = false
  let running = false
  let again = false
  let duringInit = false
  const arrived = []
  const changed = (snapshot) => {
    const deleted = getDeleted()
    const now = deleted instanceof Set ? deleted : new Set()
    if (now.size !== snapshot.size) return true
    for (const seq of now) if (!snapshot.has(seq)) return true
    return false
  }
  const pass = async () => {
    if (stopped) return
    let tombstone = false
    for (const index of arrived.splice(0)) {
      if (await deletion.tombstoneAt(core, index)) tombstone = true
    }
    const deleted = getDeleted()
    const now = deleted instanceof Set ? deleted : new Set()
    for (const seq of seen) {
      if (!now.has(seq)) {
        from = 0
        break
      }
    }
    const snapshot = new Set(now)
    seen = snapshot
    const len = await deletion.presentLength(core, snapshot, from)
    if (stopped) return
    from = len
    const first = last === -1
    const grew = !first && len > last
    last = len
    // A block that arrived during the first walk may already be in the
    // baseline, so it is reported once here.
    if (!first && (grew || tombstone || duringInit)) {
      duringInit = false
      const p = onGrow(len)
      if (p !== null && typeof p === 'object' && typeof p.then === 'function') await p
    }
    if (!stopped && changed(snapshot)) again = true
  }
  const run = async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        // A failed pass is not reported (nothing here is logged, so no
        // secret can leak) and never drops a rerun queued meanwhile.
        try {
          await pass()
        } catch {}
      } while (again)
    } finally {
      running = false
    }
  }
  const event = () => {
    if (last === -1) duringInit = true
    run()
  }
  const onAppend = () => { event() }
  const onDownload = (index) => {
    arrived.push(index)
    event()
  }
  core.on('append', onAppend)
  core.on('download', onDownload)
  run()
  return function stop () {
    stopped = true
    core.off('append', onAppend)
    core.off('download', onDownload)
  }
}

function watchFork (core, onFork) {
  let fired = false
  const handler = () => {
    if (fired) return
    fired = true
    onFork('fork')
  }
  core.on('truncate', handler)
  core.on('conflict', handler)
  return function stop () {
    core.off('truncate', handler)
    core.off('conflict', handler)
  }
}

// Starts a block-0 fetch through the quarantine store, attached to the given
// sockets, and returns { promise, addSocket }. addSocket(socket) attaches one
// more peer (an advertiser that arrived while the fetch is in flight) to the
// same quarantine core and returns true; it returns false once the fetch has
// settled (the core is being purged), for a socket already attached, for a
// socket already destroyed (or being destroyed), or while maxAttachments
// OPEN sockets are attached (a concurrent bound: a slot frees when its
// socket closes, so churn never locks out a later honest advertiser).
// A socket that closes is dropped from the fetch at once (CWE-770): closed
// sockets (and their admission peers) are never pinned until the fetch
// settles. A socket added before the core is ready is replicated only once
// it is, and only if it is still open. Settling drops the rest and removes
// the close listeners still registered on long-lived sockets.
// The result also carries the signed `length` and `byteLength` the quarantine
// core learned with block 0 (the upgrade proof of the fetch), so the caller
// can apply the log quota (S3) before anything is opened in the main store.
function startQuarantineFetch (qstore, keyHex, sockets, timeoutMs, opts = {}) {
  if (!Array.isArray(sockets) || sockets.length === 0) {
    throw new TypeError('startQuarantineFetch requires at least one socket')
  }
  const maxAttachments = opts.maxAttachments ?? MAX_FETCH_ATTACHMENTS
  const core = qstore.get({ key: b4a.from(keyHex, 'hex') })
  const attached = new Map() // open socket -> its close listener
  let ready = false
  let settled = false
  const promise = (async () => {
    try {
      await core.ready()
      ready = true
      // Sockets added while the core was opening: only the ones still open.
      for (const s of [...attached.keys()]) {
        if (gone(s)) detach(s)
        else core.replicate(s)
      }
      for (const s of sockets) addSocket(s)
      let raw = null
      try {
        raw = await core.get(0, { raw: true, timeout: timeoutMs })
      } catch {
        return { raw: null, error: 'timeout', length: 0, byteLength: 0 }
      }
      if (raw === null) return { raw: null, error: 'timeout', length: 0, byteLength: 0 }
      return { raw, error: null, length: core.length, byteLength: core.byteLength }
    } finally {
      settled = true
      for (const s of [...attached.keys()]) detach(s)
      await core.purge()
    }
  })()
  function gone (socket) {
    return !!(socket.destroyed || socket.destroying)
  }
  function detach (socket) {
    const onSocketClose = attached.get(socket)
    if (!onSocketClose) return
    socket.removeListener('close', onSocketClose)
    attached.delete(socket)
  }
  function addSocket (socket) {
    if (settled || gone(socket) || attached.has(socket)) return false
    if (attached.size >= maxAttachments) return false
    const onSocketClose = () => attached.delete(socket)
    attached.set(socket, onSocketClose)
    socket.once('close', onSocketClose)
    if (ready) core.replicate(socket)
    return true
  }
  // Test-only: how many sockets the fetch currently references.
  function attachedCount () {
    return attached.size
  }
  return { promise, addSocket, attachedCount }
}

async function quarantineGet0 (qstore, keyHex, sockets, timeoutMs) {
  return startQuarantineFetch(qstore, keyHex, sockets, timeoutMs).promise
}

module.exports = {
  PROTOCOL: admission.PROTOCOL,
  MAX_PAYLOAD: admission.MAX_PAYLOAD,
  MAX_HELLO_HAVE: admission.MAX_HELLO_HAVE,
  INVENTORY_TIMEOUT_MS: admission.INVENTORY_TIMEOUT_MS,
  MAX_INVENTORY: admission.MAX_INVENTORY,
  MAX_BAD_MESSAGES: admission.MAX_BAD_MESSAGES,
  HELLO_TIMEOUT_MS: admission.HELLO_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_FETCH_ATTACHMENTS,
  MESSAGE_BURST: admission.MESSAGE_BURST,
  MESSAGE_RATE: admission.MESSAGE_RATE,
  MAX_SEND_BACKLOG: admission.MAX_SEND_BACKLOG,
  topicFor: admission.topicFor,
  parseBootstrap,
  generateNoiseKeyPair,
  createSwarm,
  refuseOverConnectionLimit,
  joinAndFlush,
  startRediscovery,
  attachAdmission: admission.attachAdmission,
  validateMessage: admission.validateMessage,
  watchContiguous,
  watchPresent,
  watchFork,
  startQuarantineFetch,
  quarantineGet0
}
