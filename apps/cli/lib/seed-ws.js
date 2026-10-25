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
//
// The same listener serves media blocks over plain HTTP (Caddy's
// `handle /media/*` proxies here): GET|HEAD /media/<D>/<K>/<start>/<blocks>,
// D the diary key and K the media core key (lower-case hex64), start >= 1 and
// 1 <= blocks <= MEDIA_MAX_BLOCKS as canonical decimals, no query string.
// The Host check runs first (421), any other method on /media is 405, and
// anything that does not match exactly, or that Seeder#mediaRead declines
// (no D <-> K binding, D blocked, a block not local, or no mediaRead at all),
// is the same 404 'não encontrado': the answer never says why, and neither
// the path nor any key is ever echoed or logged. A hit is 200, immutable
// application/octet-stream with an exact Content-Length, streamed block by
// block with backpressure (a write returning false waits for 'drain') and
// abandoned when the client goes away. Load is bounded globally, never per
// client address (the project does not handle addresses): at most
// MEDIA_MAX_IN_FLIGHT responses at once and a token bucket of MEDIA_RATE
// requests per second (burst MEDIA_BURST); beyond either, 503 'ocupado' with
// Retry-After: 1. A response still running after MEDIA_DEADLINE_MS is
// destroyed, so slow readers cannot hold the in-flight slots forever.
const DEFAULT_HOST = '127.0.0.1'
const PATH = '/seeder'
const MAX_SOCKETS = 128
const HEADERS_TIMEOUT_MS = 4000
const CHECK_INTERVAL_MS = 1000
// How long a refused upgrade may take to flush its response before the
// socket is destroyed anyway.
const REFUSE_GRACE_MS = 1000

const MEDIA_PREFIX = '/media'
// Canonical decimals only (no sign, no leading zero); the digit caps keep the
// values safe integers before the range checks.
const MEDIA_RE = /^\/media\/([0-9a-f]{64})\/([0-9a-f]{64})\/([1-9][0-9]{0,14})\/([1-9][0-9]{0,2})$/
const MEDIA_MAX_BLOCKS = 256
const MEDIA_MAX_IN_FLIGHT = 16
const MEDIA_RATE = 64
const MEDIA_BURST = 128
const MEDIA_DEADLINE_MS = 120000
const MEDIA_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Accept-Ranges': 'none'
}

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

function send (res, code, body, extra = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...BASE_HEADERS,
    ...extra
  })
  res.end(body)
}

const NOT_FOUND = 'não encontrado\n'
const BUSY = 'ocupado\n'

// A global token bucket: rate tokens per second, at most burst stored.
function tokenBucket (rate, burst) {
  let tokens = burst
  let last = Date.now()
  return () => {
    const now = Date.now()
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

// Resolves on 'drain' or once the response is closed, whichever comes first.
function drained (res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

const CLOSED = Symbol('closed')

// Writes the blocks one at a time, waiting for 'drain' whenever the socket
// buffer is full. The iterator is driven by hand so that each next() races
// the response's close (client gone or deadline): a stalled read never keeps
// the stream waiting, and the iterator's return() is called at once without
// being awaited. Every next() and return() goes through track(), which keeps
// the in-flight slot held until it settles, so a stalled read still counts
// against MEDIA_MAX_IN_FLIGHT. More or fewer bytes than announced destroy
// the response, so a client never takes a short or overlong body for a
// complete one.
async function streamBlocks ({ res, blocks, bytes, closed, isClosed, track }) {
  let it
  try {
    it = blocks[Symbol.asyncIterator]()
  } catch {
    return res.destroy()
  }
  const cancel = () => {
    try {
      if (typeof it.return === 'function') track(it.return())
    } catch {}
  }
  let sent = 0
  while (true) {
    let step
    try {
      step = track(it.next())
    } catch {
      res.destroy()
      return cancel()
    }
    const result = await Promise.race([
      step.then((value) => ({ value }), () => null),
      closed
    ])
    if (result === CLOSED || isClosed()) return cancel()
    if (result === null || !result.value || typeof result.value !== 'object') {
      res.destroy()
      return cancel()
    }
    if (result.value.done) break
    const block = result.value.value
    if (!(block instanceof Uint8Array)) {
      res.destroy()
      return cancel()
    }
    sent += block.byteLength
    if (sent > bytes) {
      res.destroy()
      return cancel()
    }
    if (!res.write(block)) await drained(res)
    if (isClosed()) return cancel()
  }
  if (sent !== bytes) return res.destroy()
  res.end()
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
// on a loopback hostname, any port). The seeder's mediaRead(diaryHex,
// coreHex, start, blocks) -> null | { bytes, blocks } backs /media. media:
// optional overrides of the /media limits ({ maxInFlight, rate, burst,
// deadlineMs }), for tests.
function startSeedWs ({ host = DEFAULT_HOST, port, seeder, origins = null, media = {} }) {
  const allowList = origins ? new Set(origins.map(normalizeOrigin)) : null
  const maxInFlight = media.maxInFlight ?? MEDIA_MAX_IN_FLIGHT
  const deadlineMs = media.deadlineMs ?? MEDIA_DEADLINE_MS
  const takeToken = tokenBucket(media.rate ?? MEDIA_RATE, media.burst ?? MEDIA_BURST)
  let inFlight = 0

  async function serveMedia (req, res, match) {
    const start = Number(match[3])
    const count = Number(match[4])
    if (!Number.isSafeInteger(start) || count > MEDIA_MAX_BLOCKS) return send(res, 404, NOT_FOUND)
    if (!takeToken() || inFlight >= maxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    // The slot is released once the response is closed AND every seeder
    // call it started (mediaRead, next(), return()) has settled.
    inFlight++
    let resClosed = false
    let pending = 0
    let released = false
    const release = () => {
      if (released || !resClosed || pending > 0) return
      released = true
      inFlight--
    }
    const track = (value) => {
      const promise = Promise.resolve(value)
      pending++
      promise.then(() => {}, () => {}).then(() => {
        pending--
        release()
      })
      return promise
    }
    const timer = setTimeout(() => res.destroy(), deadlineMs)
    timer.unref()
    const closed = new Promise((resolve) => res.once('close', () => {
      resClosed = true
      clearTimeout(timer)
      release()
      resolve(CLOSED)
    }))
    const isClosed = () => resClosed
    let read = null
    try {
      if (typeof seeder.mediaRead === 'function') {
        read = await Promise.race([track(seeder.mediaRead(match[1], match[2], start, count)), closed])
      }
    } catch {
      read = null
    }
    if (read === CLOSED || resClosed) return
    if (!read || !Number.isSafeInteger(read.bytes) || read.bytes < 0 || !read.blocks ||
      typeof read.blocks[Symbol.asyncIterator] !== 'function') {
      return send(res, 404, NOT_FOUND)
    }
    res.writeHead(200, { ...MEDIA_HEADERS, 'Content-Length': read.bytes })
    if (req.method === 'HEAD') return res.end()
    // Headers go out now, not with the first block, which may take a while.
    res.flushHeaders()
    await streamBlocks({ res, blocks: read.blocks, bytes: read.bytes, closed, isClosed, track })
  }
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
    const pathname = req.url.split('?')[0]
    if (pathname === PATH) return send(res, 426, 'atualização de protocolo necessária\n')
    if (pathname === MEDIA_PREFIX || pathname.startsWith(MEDIA_PREFIX + '/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido\n', { Allow: 'GET, HEAD' })
      const match = MEDIA_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      return serveMedia(req, res, match).catch(() => res.destroy())
    }
    send(res, 404, NOT_FOUND)
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

module.exports = {
  startSeedWs,
  DEFAULT_HOST,
  MAX_PAYLOAD,
  MEDIA_MAX_BLOCKS,
  MEDIA_MAX_IN_FLIGHT,
  MEDIA_RATE,
  MEDIA_BURST,
  MEDIA_DEADLINE_MS
}
