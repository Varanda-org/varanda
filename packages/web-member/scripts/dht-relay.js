#!/usr/bin/env node
// Spike (G3), Node only: a @hyperswarm/dht-relay 0.4.3 node next to the
// seeder. Each WebSocket is relayed into one HyperDHT node bound like
// createSwarm's (packages/core/lib/net.js): a private bootstrap is required
// (never the public DHT), an ephemeral port, and firewall detection off on a
// loopback host.
// Divergences from the package's own bin.js: no default port, no public DHT,
// no TLS options, and no client address is ever logged (bin.js logs them).
// Exposure rules (the relay is unauthenticated, so it stays local):
// - --host must be a loopback address (127.0.0.1, ::1 or localhost).
// - The Host header of every request and upgrade must name the bound
//   host:port (or another loopback name with that port), else 421: a
//   DNS-rebinding page cannot reach it through its own hostname.
// - An Origin, when present, must be an http origin on a loopback hostname
//   (any port), else 403; no Origin (a Node client) is accepted.
// - Each WebSocket must send its first message within FIRST_MESSAGE_MS and
//   then never stay silent for IDLE_MS, else it is terminated. The relay
//   protocol's own failsafe (lib/protocol.js alive()) is armed only after a
//   ping/pong, so a client that upgrades and then sends nothing would hold
//   one of the MAX_CONNECTIONS slots forever without these deadlines.
// The installed API: relay(dht, stream) from '@hyperswarm/dht-relay'
// (index.js:7) and new Stream(false, socket) from '@hyperswarm/dht-relay/ws'.
'use strict'

const http = require('node:http')
const HyperDHT = require('hyperdht')
const { WebSocketServer } = require('ws')
const { relay } = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const { parseBootstrap } = require('@varanda/core/lib/net')

const MAX_CONNECTIONS = 64
const MAX_PAYLOAD = 1024 * 1024
const LOOPBACK_NAMES = ['127.0.0.1', '::1', 'localhost']
// First message after the upgrade (a relay client sends its handshake at once).
const FIRST_MESSAGE_MS = 10000
// 3x the relay protocol's 15 s heartbeat (lib/protocol.js heartbeatFrequency):
// the relay pings every 15 s and a live client answers with a pong.
const IDLE_MS = 45000
const USAGE = 'uso: dht-relay.js --port <n> --bootstrap <host:porta> [--bootstrap ...] [--host 127.0.0.1] [--dht-host <ip>]'

function usage (message) {
  if (message) process.stderr.write(message + '\n')
  process.stderr.write(USAGE + '\n')
  process.exit(2)
}

function parseArgs (argv) {
  const args = { port: null, host: '127.0.0.1', bootstrap: [], dhtHost: null }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    const value = argv[i + 1]
    if (!['--port', '--host', '--bootstrap', '--dht-host'].includes(name)) usage('argumento desconhecido: ' + name)
    if (value === undefined || value.startsWith('--')) usage('valor ausente para ' + name)
    i++
    if (name === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) usage('porta inválida')
      args.port = Number(value)
    } else if (name === '--host') {
      if (!LOOPBACK_NAMES.includes(value)) usage('--host deve ser um endereço de loopback (127.0.0.1, ::1 ou localhost)')
      args.host = value
    } else if (name === '--dht-host') {
      args.dhtHost = value
    } else {
      args.bootstrap.push(value)
    }
  }
  if (args.port === null) usage('--port é obrigatório')
  if (args.bootstrap.length === 0) usage('--bootstrap é obrigatório (a DHT pública nunca é usada)')
  try {
    args.bootstrap = parseBootstrap(args.bootstrap)
  } catch {
    usage('--bootstrap inválido')
  }
  return args
}

function isLoopbackHost (host) {
  return host === '127.0.0.1' || host === '::1'
}

// Tests only: VARANDA_RELAY_TEST_TIMEOUTS=<first>,<idle> in ms; each value is
// taken only when it is a positive integer shorter than its default.
function deadlines () {
  const out = { firstMs: FIRST_MESSAGE_MS, idleMs: IDLE_MS }
  const raw = process.env.VARANDA_RELAY_TEST_TIMEOUTS
  if (!raw) return out
  const [first, idle] = raw.split(',').map((v) => (/^\d+$/.test(v) ? Number(v) : 0))
  if (first > 0 && first < FIRST_MESSAGE_MS) out.firstMs = first
  if (idle > 0 && idle < IDLE_MS) out.idleMs = idle
  return out
}

function hostPort (name, port) {
  return (name.includes(':') ? '[' + name + ']' : name) + ':' + port
}

// The Host values a request may carry: every loopback name with the bound
// port (the bound host is one of them), and the bare names on port 80.
function allowedHosts (port) {
  const hosts = new Set()
  for (const name of LOOPBACK_NAMES) {
    hosts.add(hostPort(name, port))
    if (port === 80) hosts.add(name.includes(':') ? '[' + name + ']' : name)
  }
  return hosts
}

function loopbackOrigin (origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
}

// Returns the HTTP status refusing the request, or 0 when it is allowed.
function refusal (req, hosts) {
  const host = String(req.headers.host || '').toLowerCase()
  if (!hosts.has(host)) return 421
  const origin = req.headers.origin
  if (origin !== undefined && !loopbackOrigin(origin)) return 403
  return 0
}

function refuseUpgrade (socket, status) {
  socket.on('error', () => {})
  socket.end('HTTP/1.1 ' + status + ' ' + http.STATUS_CODES[status] + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.destroySoon()
}

// Terminates a WebSocket that sends nothing within firstMs of the upgrade,
// or nothing for idleMs afterwards. The timer is unref'd and cleared on close.
function watchDeadlines (socket, { firstMs, idleMs }) {
  let timer = null
  const arm = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(() => socket.terminate(), ms)
    timer.unref()
  }
  let first = true
  arm(firstMs)
  socket.on('message', () => {
    if (first) {
      first = false
      arm(idleMs)
    } else {
      timer.refresh()
    }
  })
  socket.once('close', () => clearTimeout(timer))
}

// The relay's ServerProxy (@hyperswarm/dht-relay lib/server-proxy.js:44-52)
// calls hyperdht's async server.listen() without a handler, so a rejection
// there (hyperdht lib/server.js:170-173 KEYPAIR_ALREADY_USED when another
// session of this shared DHT already listens with the same public key) is
// unhandled and would terminate Node, dropping every session. It is the
// only promise the relay leaves unhandled: lib/node-proxy.js attaches error
// handlers to every connect/lookup/announce stream, and the signee,
// handshake and firewall proxies only resolve. The wrapper below catches
// it and refuses just that session.
function refuseSession (stream, err) {
  const code = (err && err.code) || 'erro'
  const why = code === 'KEYPAIR_ALREADY_USED' ? 'chave pública já em uso neste relay' : code
  process.stderr.write('sessão recusada: ' + why + '\n')
  stream.destroy()
}

// Compatibility adapter for non-custodial clients (measured, not assumed):
// @hyperswarm/dht-relay 0.4.3's SigneeProxy (lib/signee-proxy.js:20) takes
// the announce as `(target, token, peerId, { peer: relayAddresses })`, but
// the installed hyperdht 6.34.1 calls signAnnounce(target, token, id, ann,
// keyPair) with ann = { peer: { publicKey, relayAddresses }, refresh, ... }
// (index.js:478-489, lib/announcer.js:239-250). The peer OBJECT then reaches
// the relay's array(ipv4Address) codec and protocol.signAnnounce.send throws
// 'uint must be positive', so no non-custodial announce (and no listen) is
// ever committed and the peer is never found (PEER_NOT_FOUND). The adapter
// hands the relay the shape it decodes: { peer: ann.peer.relayAddresses }.
// The client still signs hash(target, id, token, peer{publicKey,
// relayAddresses}) (lib/signee.js:59-77), equal to hyperdht's annSignable
// (lib/persistent.js:283-298) whenever ann.refresh is null (an empty chunk).
// Custodial clients never reach it (the relay signs with their secret key).
function adaptSign (sign) {
  if (typeof sign !== 'function') return sign
  return (target, token, id, ann) => sign(target, token, id, { peer: ann.peer.relayAddresses })
}

function adaptOpts (opts) {
  if (!opts) return opts
  return { ...opts, signAnnounce: adaptSign(opts.signAnnounce), signUnannounce: adaptSign(opts.signUnannounce) }
}

function compatDht (dht, stream) {
  return new Proxy(dht, {
    get (target, prop) {
      if (prop === 'announce') {
        return (topic, keyPair, relayAddresses, opts) => target.announce(topic, keyPair, relayAddresses, adaptOpts(opts))
      }
      if (prop === 'lookupAndUnannounce') {
        return (topic, keyPair, opts) => target.lookupAndUnannounce(topic, keyPair, adaptOpts(opts))
      }
      if (prop === 'createServer') {
        return (...args) => {
          const server = target.createServer(...args)
          const listen = server.listen.bind(server)
          server.listen = (keyPair, opts) => listen(keyPair, adaptOpts(opts)).catch((err) => refuseSession(stream, err))
          return server
        }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const dhtOpts = { bootstrap: args.bootstrap, port: [0, 0] }
  if (args.dhtHost) {
    dhtOpts.host = args.dhtHost
    if (isLoopbackHost(args.dhtHost)) dhtOpts.firewalled = false
  }
  const dht = new HyperDHT(dhtOpts)
  const limits = deadlines()
  let hosts = null // set once the port is bound
  const server = http.createServer((req, res) => {
    const status = hosts === null ? 503 : refusal(req, hosts)
    if (status) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end(http.STATUS_CODES[status] + '\n')
      return
    }
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('somente WebSocket\n')
  })
  server.maxConnections = MAX_CONNECTIONS
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
  const sockets = new Set()

  server.on('upgrade', (req, socket, head) => {
    const status = hosts === null ? 503 : refusal(req, hosts)
    if (status) {
      refuseUpgrade(socket, status)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    watchDeadlines(socket, limits)
    const stream = new Stream(false, socket)
    stream.on('error', () => {})
    relay(compatDht(dht, stream), stream)
  })

  // Last-resort safety net: a rejection nobody handled is logged (never an
  // address: only the error code) and the relay keeps serving.
  process.on('unhandledRejection', (err) => {
    process.stderr.write('rejeição não tratada: ' + ((err && err.code) || 'erro') + '\n')
  })

  let closing = false
  async function shutdown () {
    if (closing) return
    closing = true
    for (const socket of sockets) socket.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
    await new Promise((resolve) => server.close(() => resolve()))
    await dht.destroy()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  server.once('error', (err) => {
    process.stderr.write('erro: ' + err.message + '\n')
    process.exit(1)
  })
  server.listen(args.port, args.host, () => {
    const { port } = server.address()
    hosts = allowedHosts(port)
    process.stdout.write('dht-relay experimental (não usar em produção) ws://' + args.host + ':' + port + '\n')
    process.stdout.write(JSON.stringify({ event: 'relay', host: args.host, port }) + '\n')
  })
}

main()
