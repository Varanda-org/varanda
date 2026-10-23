#!/usr/bin/env node
// Loopback static server for the browser-member spike page.
//
//   node packages/web-member/scripts/serve-spike.js [--port 8790]
//
// Binds 127.0.0.1 only, answers GET only, and serves exactly three paths:
// / (web/index.html), /app.js (dist/app.js) and /relay.js (dist/relay.js,
// when built). The Host header must be 127.0.0.1:<port> or localhost:<port>
// (DNS-rebinding defence, as apps/cli/lib/serve/server.js does), else 421.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const ROUTES = {
  '/': { file: path.join(ROOT, 'web', 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: path.join(DIST, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/relay.js': { file: path.join(DIST, 'relay.js'), type: 'text/javascript; charset=utf-8' }
}

// 'wasm-unsafe-eval' (measured in Chromium): sha512-wasm, sha256-wasm and
// blake2b-wasm (via hypercore-crypto/sodium-javascript) compile their
// WebAssembly with new WebAssembly.Module() at load time, which a bare
// script-src 'self' blocks; it permits WebAssembly compilation only, not eval.
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; " +
    "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
}

function parseArgs (argv) {
  let port = 8790
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) {
      port = Number(argv[++i])
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('porta inválida')
    } else {
      throw new Error('argumento desconhecido: ' + argv[i])
    }
  }
  return { port }
}

function createSpikeServer () {
  let boundPort = null

  function reply (res, status, text, extra = {}) {
    res.writeHead(status, {
      ...HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      ...extra
    })
    res.end(text)
  }

  function onRequest (req, res) {
    const host = req.headers.host
    if (host !== '127.0.0.1:' + boundPort && host !== 'localhost:' + boundPort) {
      return reply(res, 421, 'host inválido\n', { Connection: 'close' })
    }
    if (req.method !== 'GET') return reply(res, 405, 'método não permitido\n', { Allow: 'GET' })
    const pathOnly = typeof req.url === 'string' ? req.url.split('?')[0] : ''
    const route = Object.prototype.hasOwnProperty.call(ROUTES, pathOnly) ? ROUTES[pathOnly] : null
    if (route === null) return reply(res, 404, 'não encontrado\n')
    fs.readFile(route.file, (err, data) => {
      if (err) return reply(res, 404, 'não encontrado\n')
      res.writeHead(200, { ...HEADERS, 'Content-Type': route.type, 'Content-Length': data.length })
      res.end(data)
    })
  }

  const server = http.createServer(onRequest)
  return {
    server,
    listen (port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          boundPort = server.address().port
          resolve(boundPort)
        })
      })
    },
    close () {
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

async function main () {
  const { port } = parseArgs(process.argv.slice(2))
  const spike = createSpikeServer()
  const bound = await spike.listen(port)
  if (!fs.existsSync(ROUTES['/app.js'].file)) console.log('aviso: dist/app.js ausente; rode scripts/build.js')
  console.log('spike em http://127.0.0.1:' + bound + '/')
  const stop = () => spike.close().then(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (require.main === module) {
  main().catch((err) => {
    console.error('erro: ' + err.message)
    process.exitCode = 1
  })
}

module.exports = { createSpikeServer }
