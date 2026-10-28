'use strict'

const http = require('node:http')

// Health and metrics endpoint of `seed --health-port` (docs/protocol.md
// section 7): read-only, built only from Seeder#stats() (counts and sizes,
// never a key, a certificate, an address or a block), and nothing is logged
// per request. GET or HEAD /health -> JSON, 200 while the seeder is ready and
// 503 while it starts or closes; /metrics -> Prometheus text; anything else
// 404, other methods 405.
const DEFAULT_HOST = '127.0.0.1'
const MAX_SOCKETS = 16
const HEADERS_TIMEOUT_MS = 4000
const REQUEST_TIMEOUT_MS = 5000

// A missing or non-finite value is reported as 0.
function finite (v) {
  return Number.isFinite(v) ? v : 0
}

// [name, help, value(snapshot)]: every metric is a gauge.
const METRICS = [
  ['ready', '1 quando o semeador está pronto; 0 ao iniciar ou encerrar', (s) => (s.status === 'ok' ? 1 : 0)],
  ['admitted_diaries', 'diários admitidos', (s) => s.admitted],
  ['dropping_diaries', 'diários em descarte (limpeza em andamento)', (s) => s.dropping],
  ['active_diaries_day', 'diários servidos cujo tamanho assinado cresceu hoje (dia de Brasília; aproximado, só em memória, zera quando o semeador reinicia)', (s) => finite(s.activeDay)],
  ['active_diaries_week', 'diários servidos cujo tamanho assinado cresceu nos últimos 7 dias de Brasília, hoje incluído (aproximado, só em memória, zera quando o semeador reinicia)', (s) => finite(s.activeWeek)],
  ['blocks', 'blocos guardados dos diários admitidos', (s) => s.blocks],
  ['bytes', 'bytes dos diários admitidos (tamanho assinado)', (s) => s.bytes],
  ['connections', 'conexões abertas', (s) => s.connections],
  ['swarm', 'conexões abertas pela rede P2P (swarm)', (s) => finite(s.swarm)],
  ['external', 'conexões externas abertas (WebSocket), handshakes em curso incluídos', (s) => finite(s.external)],
  ['max_connections', 'limite de conexões da rede P2P (swarm)', (s) => finite(s.maxConnections)],
  ['max_external', 'limite de conexões externas (WebSocket)', (s) => finite(s.maxExternal)],
  ['peers', 'pares com canal de admissão aberto', (s) => s.peers],
  ['firewalled', '1 quando a DHT se vê atrás de firewall ou NAT', (s) => (s.firewalled ? 1 : 0)],
  ['blocked', 'chaves na lista de bloqueio adotada', (s) => s.blocked],
  ['blocklist_seq', 'seq da lista de bloqueio adotada; 0 sem lista', (s) => s.blocklistSeq],
  ['media_cores', 'núcleos de mídia vinculados a diários admitidos', (s) => s.mediaCores],
  ['media_bytes', 'bytes dos núcleos de mídia (tamanho assinado)', (s) => s.mediaBytes],
  ['index_records', 'registros no índice de engajamento (em memória)', (s) => s.indexRecords],
  ['index_saturated', '1 quando o índice de engajamento atingiu o limite e há diários pausados', (s) => (s.indexSaturated ? 1 : 0)],
  ['topic_posts', 'publicações no índice de assuntos (em memória)', (s) => s.topicPosts],
  ['topic_saturated', '1 quando o índice de assuntos atingiu um limite e há diários pausados', (s) => (s.topicSaturated ? 1 : 0)],
  ['uptime_seconds', 'segundos desde o início do semeador', (s) => s.uptimeSeconds]
]

function metricsText (snapshot) {
  const lines = []
  for (const [name, help, value] of METRICS) {
    const full = 'varanda_seeder_' + name
    lines.push('# HELP ' + full + ' ' + help, '# TYPE ' + full + ' gauge', full + ' ' + value(snapshot))
  }
  return lines.join('\n') + '\n'
}

function send (req, res, code, type, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

// Listens on host:port (port 0: the system picks one) and resolves
// { host, port, close() } once listening; a listen error rejects (EADDRINUSE
// carries its code). stats() is Seeder#stats.
function startHealth ({ host = DEFAULT_HOST, port, stats }) {
  const startedAt = Date.now()
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, 'text/plain; charset=utf-8', 'método não permitido\n', { Allow: 'GET, HEAD' })
    }
    const pathname = req.url.split('?')[0]
    if (pathname !== '/health' && pathname !== '/metrics') {
      return send(req, res, 404, 'text/plain; charset=utf-8', 'não encontrado\n')
    }
    let snapshot
    try {
      snapshot = { ...stats(), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }
    } catch {
      return send(req, res, 500, 'text/plain; charset=utf-8', 'erro interno\n')
    }
    if (pathname === '/metrics') {
      return send(req, res, 200, 'text/plain; version=0.0.4; charset=utf-8', metricsText(snapshot))
    }
    const { status, uptimeSeconds, ...counts } = snapshot
    const body = JSON.stringify({ status, uptimeSeconds, ...counts }) + '\n'
    send(req, res, status === 'ok' ? 200 : 503, 'application/json; charset=utf-8', body)
  })
  server.maxConnections = MAX_SOCKETS
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS

  let closing = null
  const close = () => {
    if (closing) return closing
    closing = new Promise((resolve) => {
      server.close(() => resolve())
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
      resolve({ host: address.address, port: address.port, close })
    })
  })
}

module.exports = { startHealth, metricsText, DEFAULT_HOST }
