// Spike (G3): a member held by a browser reaches the Hyperswarm DHT through a
// @hyperswarm/dht-relay node over a WebSocket, announces itself on a topic
// and connects directly (end-to-end Noise) to the peers it finds there.
// Browser-safe: no node:* module, no process, no Buffer global, and neither
// hyperswarm nor hyperdht's index (whose browser stub throws) is loaded;
// @hyperswarm/dht-relay 0.4.3 only requires hyperdht/lib/constants and
// hyperdht/lib/messages (lib/handshake.js:4,8, lib/signee.js:3).
//
// Read from the installed @hyperswarm/dht-relay 0.4.3 (not assumed):
// - The client is the package's default export, the Node class
//   (index.js:5, lib/node.js): new DHT(stream, { keyPair, custodial }).
// - The WebSocket transport is require('@hyperswarm/dht-relay/ws')
//   (ws.js -> lib/transport/ws.js): new Stream(isInitiator, socket), driven
//   only through addEventListener, readyState, send and close.
// - Non-custodial option: `custodial: false` (lib/node.js:22). With it the
//   secret key never leaves this side (lib/messages.js only encodes
//   secretKey when custodial), the Noise handshake runs here
//   (lib/handshake.js) and every connection is a @hyperswarm/secret-stream
//   whose keys only this side holds (lib/node.js:131-142, lib/server.js:
//   152-170). The package default is custodial (the relay holds the secret
//   key and terminates Noise).
// - There is no hyperswarm-like join(): announce(topic, keyPair) and
//   lookup(topic) return Query readables of { peers: [{ publicKey }] }
//   records (lib/codecs.js announcers); createServer().listen(keyPair) is
//   what lets the other side dial; connect(publicKey) dials.
// - Divergence from the spec: announce() requires the key pair explicitly
//   (lib/node.js:204), and lookup() results carry the announcer list, not
//   ready-made connections.
// - The client never notices the transport closing by itself: lib/node.js
//   onStreamClose only detaches protocol handlers (`destroyed` stays false
//   and no 'close' is emitted), while lib/server.js emits 'close' and
//   lib/query.js destroys the query. So this module watches the socket's
//   own 'close' event to stop its timers and queries.
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const b4a = require('b4a')

// Noncustodial option of the installed client (see above).
const CUSTODY_OPTION = { custodial: false }
const LOOKUP_INTERVAL_MS = 1000
// A relayed announce() is a one-shot query: nothing renews the records it
// leaves on the DHT nodes, which expire (hyperdht index.js:614 defaultMaxAge,
// 20 min). Re-announce the way the libraries keep their own records fresh:
// hyperdht's Announcer re-runs its update about every 5 min
// (lib/announcer.js:111-125, 100 x 3 s) and hyperswarm's PeerDiscovery
// refreshes every 10 min (lib/peer-discovery.js:4). 5 min is the stricter
// of the two and renews each record four times within its lifetime.
const ANNOUNCE_REFRESH_MS = 5 * 60 * 1000
// After discovering a peer that should dial us (its key compares lower), wait
// this long for its connection before dialing it ourselves: a peer that never
// found our announce would otherwise stay unreachable forever. The rare
// double connection is settled by the same tie-break both sides apply.
const DIAL_GRACE_MS = 5000

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// The same tie-break hyperswarm applies to duplicate connections
// (hyperswarm index.js _handleServerConnection): the side whose public key
// compares greater is the expected initiator, so both ends keep the same one.
function expectedInitiator (ownKey, remoteKey) {
  return b4a.compare(ownKey, remoteKey) > 0
}

// Options beyond { socket, keyPair } exist for tests only: refreshMs /
// lookupMs / graceMs shrink the timers and dht replaces the relay client
// with a fake. Custodial mode (the package default, where the relay receives
// the secret key) is refused unless unsafeDiagnosticCustodial is also true;
// only the spike's diagnostic retry (spike/relay-eval.test.js) passes both.
function createRelayedSwarm ({
  socket,
  keyPair = null,
  custodial = false,
  unsafeDiagnosticCustodial = false,
  refreshMs = ANNOUNCE_REFRESH_MS,
  lookupMs = LOOKUP_INTERVAL_MS,
  graceMs = DIAL_GRACE_MS,
  dht = null
} = {}) {
  if (custodial && unsafeDiagnosticCustodial !== true) {
    throw new Error('modo custodial recusado: a chave secreta iria para o relay')
  }
  if (dht === null) {
    const opts = custodial ? {} : { ...CUSTODY_OPTION }
    if (keyPair !== null) opts.keyPair = keyPair
    dht = new DHT(new Stream(true, socket), opts)
  }
  const ownKeyPair = dht.defaultKeyPair
  const listeners = new Set()
  const connections = new Map() // remote key hex -> connection
  const dialing = new Set() // remote key hex
  const pendingDials = new Map() // remote key hex -> grace timer
  const queries = new Set()
  const timers = new Set()
  let server = null
  let destroyed = false
  let closed = false // the transport is gone: no query reaches the relay

  function emitConnection (conn) {
    for (const cb of listeners) {
      try {
        cb(conn)
      } catch {}
    }
  }

  // Keeps one connection per remote key, with hyperswarm's tie-break.
  function track (conn) {
    conn.on('error', noop)
    if (destroyed) {
      conn.destroy()
      return
    }
    const remote = conn.remotePublicKey
    if (!remote) {
      conn.destroy()
      return
    }
    const id = hex(remote)
    if (id === hex(ownKeyPair.publicKey)) {
      conn.destroy()
      return
    }
    const existing = connections.get(id)
    if (existing) {
      const keepNew = expectedInitiator(ownKeyPair.publicKey, remote) === conn.isInitiator
      if (!keepNew) {
        conn.destroy()
        return
      }
      connections.delete(id)
      existing.destroy()
    }
    connections.set(id, conn)
    conn.once('close', () => {
      if (connections.get(id) === conn) connections.delete(id)
    })
    emitConnection(conn)
  }

  function connect (remote, id) {
    dialing.add(id)
    const conn = dht.connect(remote)
    conn.on('error', noop)
    const done = () => dialing.delete(id)
    conn.once('close', done)
    // The Noise secret stream emits 'connect' once its handshake completed.
    conn.once('connect', () => {
      done()
      track(conn)
    })
  }

  function dial (remote) {
    const id = hex(remote)
    if (destroyed || closed || connections.has(id) || dialing.has(id)) return
    if (id === hex(ownKeyPair.publicKey)) return
    if (expectedInitiator(ownKeyPair.publicKey, remote)) {
      connect(remote, id)
      return
    }
    // The other side is the expected initiator (it dials us once it finds
    // our announce). If its connection has not arrived after the grace
    // period, dial anyway: it may never have found us.
    if (pendingDials.has(id)) return
    const timer = setTimeout(() => {
      pendingDials.delete(id)
      if (destroyed || closed || connections.has(id) || dialing.has(id)) return
      connect(remote, id)
    }, graceMs)
    pendingDials.set(id, timer)
  }

  function runQuery (query) {
    queries.add(query)
    query.on('error', noop)
    query.on('data', (record) => {
      for (const peer of (record && record.peers) || []) {
        if (peer && peer.publicKey) dial(peer.publicKey)
      }
    })
    query.once('close', () => queries.delete(query))
    return query
  }

  function stopTimers () {
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    for (const timer of pendingDials.values()) clearTimeout(timer)
    pendingDials.clear()
  }

  // The transport closed under us (the relay refused the session, the
  // network dropped, or destroy() ran): no timer may issue another query on
  // it, as such queries never settle.
  function onTransportClose () {
    if (closed) return
    closed = true
    stopTimers()
    for (const q of queries) q.destroy()
    queries.clear()
  }

  if (socket && typeof socket.addEventListener === 'function') {
    socket.addEventListener('close', onTransportClose)
  }

  // Resolves once the relay confirmed the listen; rejects if the transport
  // closes first (the relay refuses a session whose key is already in use).
  function listen (srv) {
    return new Promise((resolve, reject) => {
      const onClose = () => reject(new Error('relay fechou a conexão antes de escutar'))
      srv.once('close', onClose)
      srv.listen(ownKeyPair).then(() => {
        srv.off('close', onClose)
        resolve()
      }, reject)
    })
  }

  async function join (topic) {
    if (destroyed) throw new Error('enxame destruído')
    if (closed) throw new Error('relay desconectado')
    if (server === null) {
      server = dht.createServer((conn) => track(conn))
      await listen(server)
    }
    runQuery(dht.announce(topic, ownKeyPair))
    runQuery(dht.lookup(topic))
    if (destroyed || closed) return
    // Peers that announce after our first lookup are found by repeating it.
    timers.add(setInterval(() => {
      if (!destroyed && !closed) runQuery(dht.lookup(topic))
    }, lookupMs))
    // Our own records expire on the DHT nodes unless renewed (see
    // ANNOUNCE_REFRESH_MS).
    timers.add(setInterval(() => {
      if (!destroyed && !closed) runQuery(dht.announce(topic, ownKeyPair))
    }, refreshMs))
  }

  function onConnection (cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  async function destroy () {
    if (destroyed) return
    destroyed = true
    stopTimers()
    for (const q of queries) q.destroy()
    queries.clear()
    for (const conn of connections.values()) conn.destroy()
    connections.clear()
    await dht.destroy({ force: true })
    onTransportClose()
  }

  return {
    dht,
    keyPair: ownKeyPair,
    custody: custodial ? 'default' : 'noncustodial',
    connections,
    join,
    onConnection,
    destroy
  }
}

module.exports = { createRelayedSwarm, CUSTODY_OPTION, ANNOUNCE_REFRESH_MS, DIAL_GRACE_MS }
