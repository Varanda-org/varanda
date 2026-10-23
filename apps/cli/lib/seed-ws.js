'use strict'

const http = require('node:http')
const path = require('node:path')
const { WebSocketServer, createWebSocketStream } = require('ws')
const { MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/seeder')

// WebSocket entry of `seed --ws-port` (docs/protocol.md section 7): a phase 0
// spike that lets a browser-held member replicate through the seeder. Each
// WebSocket on /seeder is handed, as a raw duplex, to Seeder#acceptStream,
// which runs the Noise handshake keyed with the seeder key. The bytes on the
// socket are that Noise stream: a TLS proxy may forward them but must not
// terminate Noise.
//
// Members stay unauthenticated by design (the announce, docs/protocol.md
// section 6), but the entry must not be reachable by arbitrary web pages:
// WebSockets are not subject to CORS, so any page in a browser on this host
// could otherwise open ws://127.0.0.1:<port>/seeder. Two checks guard it:
// - Host (DNS-rebinding defence): the Host header must name this listener,
//   <bound host>:<port> (IPv6 bracketed), plus localhost / 127.0.0.1 / [::1]
//   on the same port when the bind is loopback; otherwise 421.
// - Origin: a request without an Origin header (a non-browser client: the
//   CLI, Node, native apps) is accepted; one with an Origin must be in the
//   allow-list (`origins`, exact origins), otherwise 403. Without `origins`,
//   the default allows any http origin on a loopback hostname (any port), so
//   the loopback spike page works and public pages are refused. There is no
//   CLI flag for `origins` yet: the public deployment PR adds --ws-origin to
//   allow the PWA's origin.
// The seeder also caps external sockets at half its connection limit
// (Seeder#maxExternal), so these clients never starve swarm peers. Nothing
// is logged per connection and no address is ever logged.
const DEFAULT_HOST = '127.0.0.1'
const PATH = '/seeder'
const MAX_SOCKETS = 128
const HEADERS_TIMEOUT_MS = 4000
const CHECK_INTERVAL_MS = 1000
// How long a refused upgrade may take to flush its response before the
// socket is destroyed anyway.
const REFUSE_GRACE_MS = 1000

// The secret-stream's per-frame authentication overhead, read from the
// sodium-secretstream that the installed @hyperswarm/secret-stream (the one
// @varanda/core uses) loads, so it follows the version actually in use.
function secretStreamAbytes () {
  const seederFile = require.resolve('@varanda/core/lib/seeder')
  const secretStream = require.resolve('@hyperswarm/secret-stream', { paths: [path.dirname(seederFile)] })
  const sodium = require.resolve('sodium-secretstream', { paths: [path.dirname(secretStream)] })
  return require(sodium).ABYTES
}

// The WebSocket message limit follows the seeder's frame guard, not a value
// of its own: NoiseSecretStream writes each secret-stream frame with one
// write and createWebSocketStream sends each write as ONE WebSocket message,
// so a legitimate member's message is one frame, and the guard (FrameGuard in
// packages/core/lib/seeder.js) accepts post-handshake frames whose declared
// length is up to MAX_EXTERNAL_FRAME (about 8 MiB: hypercore corks protomux,
// which flushes a corked batch only at MAX_BATCH = 8 MiB). A smaller limit
// here would close such a member with 1009 before the guard ever saw the
// frame. The message therefore carries the 3-byte length prefix plus a
// declared length of at most MAX_EXTERNAL_FRAME (which already includes the
// ABYTES tag); ABYTES is added again and a small margin on top so the
// WebSocket limit never undercuts the guard. The memory bound per connection
// is therefore about MAX_EXTERNAL_FRAME, the same as the guard's.
const FRAME_PREFIX_BYTES = 3
const PAYLOAD_MARGIN_BYTES = 1024
const MAX_PAYLOAD = MAX_EXTERNAL_FRAME + FRAME_PREFIX_BYTES + secretStreamAbytes() + PAYLOAD_MARGIN_BYTES

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']

// host:port as it appears in a Host header (IPv6 literals bracketed).
function authority (host, port) {
  return (host.includes(':') ? '[' + host + ']' : host) + ':' + port
}

function isLoopback (host) {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

// The Host values that name this listener (lower case).
function allowedHosts (configured, address, port) {
  const hosts = new Set([authority(address, port).toLowerCase(), authority(configured, port).toLowerCase()])
  if (isLoopback(address) || isLoopback(configured)) {
    for (const name of LOOPBACK_NAMES) hosts.add(name + ':' + port)
  }
  return hosts
}

// Normalizes an exact origin of the allow-list ('http://127.0.0.1:8790').
function normalizeOrigin (origin) {
  const url = new URL(origin)
  return url.protocol + '//' + url.host
}

// Origin policy: no Origin header (non-browser client) is accepted; 'null'
// and unparsable origins are refused; otherwise the origin must be in the
// explicit allow-list or, without one, be http on a loopback hostname.
function originAllowed (origin, allowList) {
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (allowList) return allowList.has(url.protocol + '//' + url.host)
  return url.protocol === 'http:' && LOOPBACK_NAMES.includes(url.hostname)
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function send (res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...BASE_HEADERS
  })
  res.end(body)
}

// Writes the refusal and then destroys the socket: end() alone only closes
// the writable half, and after 'upgrade' the socket is no longer covered by
// the HTTP server's timeouts, so a client that never closes its side would
// hold it (and a maxConnections slot) forever. The unref'd timer destroys it
// even if the response never finishes flushing.
function refuse (socket, code, reason) {
  const body = reason + '\n'
  const timer = setTimeout(() => socket.destroy(), REFUSE_GRACE_MS)
  timer.unref()
  socket.once('close', () => clearTimeout(timer))
  try {
    socket.end('HTTP/1.1 ' + code + '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ' +
      Buffer.byteLength(body) + '\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n' + body,
    () => socket.destroy())
  } catch {
    socket.destroy()
  }
}

// Listens on host:port (port 0: the system picks one) and resolves
// { host, port, close() } once listening; a listen error rejects (EADDRINUSE
// carries its code). seeder is a Seeder (stats(), acceptStream()). origins:
// optional array of exact browser origins allowed to connect (default: http
// on a loopback hostname, any port).
function startSeedWs ({ host = DEFAULT_HOST, port, seeder, origins = null }) {
  const allowList = origins ? new Set(origins.map(normalizeOrigin)) : null
  // Filled once listening (port 0 case); no request arrives before that.
  let hosts = new Set()
  const hostOk = (req) => typeof req.headers.host === 'string' && hosts.has(req.headers.host.toLowerCase())

  // headersTimeout is only enforced when Node's connection check runs
  // (connectionsCheckingInterval, 30 s by default): check every second so an
  // incomplete request holds a slot for about HEADERS_TIMEOUT_MS, not 30 s.
  const server = http.createServer({ connectionsCheckingInterval: CHECK_INTERVAL_MS }, (req, res) => {
    req.resume()
    if (!hostOk(req)) {
      res.setHeader('Connection', 'close')
      return send(res, 421, 'host inválido\n')
    }
    if (req.url.split('?')[0] === PATH) return send(res, 426, 'atualização de protocolo necessária\n')
    send(res, 404, 'não encontrado\n')
  })
  server.maxConnections = MAX_SOCKETS
  server.headersTimeout = HEADERS_TIMEOUT_MS

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })

  // Sockets between the 'upgrade' event and either their hand-off to ws
  // (then tracked by wss.clients) or their destruction; close() destroys them.
  const upgrading = new Set()
  let closing = null

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    if (closing) return socket.destroy()
    upgrading.add(socket)
    socket.once('close', () => upgrading.delete(socket))
    if (!hostOk(req)) return refuse(socket, '421 Misdirected Request', 'host inválido')
    if (req.url.split('?')[0] !== PATH) return refuse(socket, '404 Not Found', 'não encontrado')
    if (!originAllowed(req.headers.origin, allowList)) return refuse(socket, '403 Forbidden', 'origem não permitida')
    let ok = false
    try {
      ok = seeder.stats().status === 'ok'
    } catch {}
    if (!ok) return refuse(socket, '503 Service Unavailable', 'indisponível')
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgrading.delete(socket)
      ws.on('error', () => {})
      if (closing) return ws.terminate()
      let duplex
      try {
        duplex = createWebSocketStream(ws)
        duplex.on('error', () => {})
        // A closed WebSocket only ends the duplex's readable side; destroy it
        // so the seeder releases the connection slot at once.
        ws.once('close', () => duplex.destroy())
        Promise.resolve(seeder.acceptStream(duplex)).then((noise) => {
          if (!noise) ws.terminate()
        }, () => ws.terminate())
      } catch {
        ws.terminate()
      }
    })
  })

  const close = () => {
    if (closing) return closing
    closing = new Promise((resolve) => {
      server.close(() => resolve())
      for (const socket of upgrading) socket.destroy()
      upgrading.clear()
      for (const ws of wss.clients) ws.terminate()
      server.closeAllConnections()
    })
    return closing
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', () => {})
      const address = server.address()
      hosts = allowedHosts(host, address.address, address.port)
      resolve({ host: address.address, port: address.port, close })
    })
  })
}

module.exports = { startSeedWs, DEFAULT_HOST, MAX_PAYLOAD }
