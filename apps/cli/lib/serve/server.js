'use strict'

// The loopback HTTP + WebSocket server of varanda-serve (docs/rpc.md
// section 11). One node session; any number of sockets up to MAX_SOCKETS, and
// exactly one authenticated socket at a time (the session's emitter).
// Every request and upgrade: the Host header must name this server
// (127.0.0.1:<port> or localhost:<port>, DNS-rebinding defence). No CORS.

const fs = require('node:fs')
const http = require('node:http')
const { WebSocketServer, WebSocket } = require('ws')
const { createServerDispatcher, parseMessage, MAX_REQUEST, MAX_OUTBOUND } = require('@varanda/rpc')
const { resolveStatic } = require('./static')

const MAX_SOCKETS = 4
const RATE_PER_SECOND = 20
const RATE_BURST = 40

const STATUS_TEXT = {
  403: 'Forbidden',
  404: 'Not Found',
  421: 'Misdirected Request',
  503: 'Service Unavailable'
}

const noop = () => {}

// host[:port] as browsers write it in Host and Origin: the default port 80
// is omitted.
function authority (host, port) {
  return port === 80 ? host : host + ':' + port
}

function securityHeaders (port) {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; " +
      `connect-src 'self' ws://${authority('127.0.0.1', port)} ws://${authority('localhost', port)}; ` +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store'
  }
}

// A token bucket: `rate` tokens per second, at most `burst`.
function createBucket (rate, burst, now = Date.now) {
  let tokens = burst
  let last = now()
  return function take () {
    const t = now()
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate)
    last = t
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

// session: a createSession() result. -> { listen(), close(), port }
function createServeServer ({ session, port, origins = [], uiRoot = null, token, openTimeoutMs = 5000, accountOrigin = null }) {
  let boundPort = null
  let headers = null
  let allowedOrigins = null
  let stopping = false
  let reserved = 0 // upgrades accepted but not yet connected
  let current = null // the authenticated connection
  const conns = new Set()

  function hostOk (req) {
    const host = req.headers.host
    return host === authority('127.0.0.1', boundPort) || host === authority('localhost', boundPort)
  }

  function reply (res, status, body, extra = {}) {
    const text = body === undefined ? '' : body + '\n'
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      ...extra
    })
    res.end(res.req.method === 'HEAD' ? undefined : text)
  }

  async function onRequest (req, res) {
    if (!hostOk(req)) return reply(res, 421, 'host inválido', { Connection: 'close' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'método não permitido', { Allow: 'GET, HEAD' })
    const pathOnly = typeof req.url === 'string' ? req.url.split('?')[0] : ''
    if (pathOnly === '/rpc') return reply(res, 426, 'use WebSocket', { Upgrade: 'websocket' })
    if (uiRoot === null) return reply(res, 404, 'não encontrado')
    let found = null
    try {
      found = await resolveStatic(uiRoot, req.url)
    } catch {}
    if (found === null) return reply(res, 404, 'não encontrado')
    let data
    try {
      data = await fs.promises.readFile(found.file)
    } catch {
      return reply(res, 404, 'não encontrado')
    }
    res.writeHead(200, { ...headers, 'Content-Type': found.type, 'Content-Length': data.length })
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  function refuseUpgrade (socket, status) {
    try {
      socket.end(
        'HTTP/1.1 ' + status + ' ' + STATUS_TEXT[status] + '\r\n' +
        Object.entries(headers).map(([k, v]) => k + ': ' + v + '\r\n').join('') +
        'Connection: close\r\nContent-Length: 0\r\n\r\n'
      )
    } catch {}
    socket.destroy()
  }

  function onUpgrade (req, socket, head) {
    socket.on('error', noop)
    if (!hostOk(req)) return refuseUpgrade(socket, 421)
    if (req.url !== '/rpc') return refuseUpgrade(socket, 404)
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return refuseUpgrade(socket, 403)
    if (stopping || conns.size + reserved >= MAX_SOCKETS) return refuseUpgrade(socket, 503)
    reserved++
    let settled = false
    const release = () => {
      if (settled) return
      settled = true
      reserved--
    }
    socket.once('close', release)
    wss.handleUpgrade(req, socket, head, (ws) => {
      release()
      if (stopping) return ws.terminate()
      onConnection(ws)
    })
  }

  function closeConn (conn, code, reason) {
    if (conn.closing) return
    conn.closing = true
    clearTimeout(conn.timer)
    conn.dispatcher.close()
    try { conn.ws.close(code, reason) } catch {}
  }

  // node.info carries the account origin (docs/rpc.md 5.2): the app reads it
  // as config.accountOrigin to turn the Páginas on for this core node.
  function handlersOf () {
    const handlers = session.handlers
    if (accountOrigin === null) return handlers
    const info = handlers['node.info']
    return { ...handlers, 'node.info': async (params) => ({ ...(await info(params)), accountOrigin }) }
  }

  function onConnection (ws) {
    const conn = { ws, dispatcher: null, timer: null, closing: false, take: createBucket(RATE_PER_SECOND, RATE_BURST) }
    conns.add(conn)
    ws.on('error', noop)

    conn.dispatcher = createServerDispatcher({
      handlers: handlersOf(),
      token,
      send (message, text) {
        if (conn.closing || ws.readyState !== WebSocket.OPEN) return
        ws.send(text)
        // A client that does not read: drop it.
        if (ws.bufferedAmount > MAX_OUTBOUND) {
          conn.closing = true
          conn.dispatcher.close()
          ws.terminate()
        }
      },
      onProtocolError () {
        closeConn(conn, 1008, 'erro de protocolo')
      }
    })

    conn.timer = setTimeout(() => {
      if (!conn.dispatcher.opened) closeConn(conn, 1008, 'sessão não aberta')
    }, openTimeoutMs)

    ws.on('message', (data, isBinary) => {
      if (conn.closing) return
      if (isBinary) return closeConn(conn, 1003, 'só texto')
      if (!conn.take()) return closeConn(conn, 1008, 'mensagens demais')
      const parsed = parseMessage(data.toString('utf8'), MAX_REQUEST)
      if (!parsed.ok) return closeConn(conn, 1008, 'erro de protocolo')
      const wasOpen = conn.dispatcher.opened
      conn.dispatcher.receive(parsed.value)
      if (!wasOpen && conn.dispatcher.opened && !conn.closing) authenticate(conn)
    })

    ws.on('close', () => {
      conns.delete(conn)
      conn.closing = true
      clearTimeout(conn.timer)
      conn.dispatcher.close()
      if (current === conn) {
        current = null
        session.detach().catch(noop)
      }
    })
  }

  function authenticate (conn) {
    clearTimeout(conn.timer)
    const previous = current
    current = conn
    session.attach(conn.dispatcher.emit)
    if (previous !== null) closeConn(previous, 4000, 'substituída')
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch(() => {
      try { reply(res, 404, 'não encontrado') } catch {}
    })
  })
  server.on('upgrade', onUpgrade)
  server.on('clientError', (_err, socket) => socket.destroy())

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REQUEST,
    perMessageDeflate: false,
    clientTracking: false
  })

  function listen () {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        boundPort = server.address().port
        headers = securityHeaders(boundPort)
        allowedOrigins = new Set(origins)
        if (uiRoot !== null) {
          allowedOrigins.add('http://' + authority('127.0.0.1', boundPort))
          allowedOrigins.add('http://' + authority('localhost', boundPort))
        }
        resolve(boundPort)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ port, host: '127.0.0.1', exclusive: true })
    })
  }

  // Stops accepting, closes every socket (1001), awaits the session, then the server.
  async function close () {
    if (stopping) return
    stopping = true
    const gone = [...conns].map((conn) => new Promise((resolve) => {
      if (conn.ws.readyState === WebSocket.CLOSED) return resolve()
      conn.ws.once('close', resolve)
    }))
    for (const conn of conns) closeConn(conn, 1001, 'servidor encerrando')
    current = null
    await session.close()
    // Give the close handshakes a moment before cutting what is left.
    let timer
    await Promise.race([
      Promise.all(gone),
      new Promise((resolve) => { timer = setTimeout(resolve, 1000) })
    ])
    clearTimeout(timer)
    await new Promise((resolve) => {
      server.close(() => resolve())
      for (const conn of conns) {
        try { conn.ws.terminate() } catch {}
      }
      server.closeAllConnections()
    })
  }

  return {
    listen,
    close,
    get port () { return boundPort }
  }
}

module.exports = { createServeServer, createBucket, securityHeaders, authority, MAX_SOCKETS, RATE_PER_SECOND, RATE_BURST }
