#!/usr/bin/env node
// Development-only loopback measurement. No diaries or application traffic.
const http = require('node:http')
const { performance } = require('node:perf_hooks')
const Hypercore = require('hypercore')
const HyperDHT = require('hyperdht')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, createWebSocketStream } = require('ws')
const { attachAdmission } = require('@varanda/core/lib/admission')

const DESCRIPTION = 'Mede conexões admitidas ociosas, não tráfego real; somente loopback, para desenvolvimento.'
const USAGE = 'uso: node apps/cli/scripts/load-ws.js --port <1..65535> [--clients <1..4096> (padrão: 32)] [--hold-ms <0..25000> (padrão: 10000)] [--health-port <1..65535>] [--json]. ' + DESCRIPTION
const HANDSHAKE_TIMEOUT_MS = 10000

function parseArgs (argv) {
  const options = { clients: 32, holdMs: 10000, json: false }
  const fields = new Map([
    ['--port', ['port', 1, 65535]],
    ['--clients', ['clients', 1, 4096]],
    ['--hold-ms', ['holdMs', 0, 25000]],
    ['--health-port', ['healthPort', 1, 65535]]
  ])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) return null
    seen.add(flag)
    if (flag === '--json') {
      options.json = true
      continue
    }
    const field = fields.get(flag)
    if (!field) return null
    const value = argv[++i]
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null
    const number = Number(value)
    const [name, min, max] = field
    if (!Number.isSafeInteger(number) || number < min || number > max) return null
    options[name] = number
  }
  return options.port === undefined ? null : options
}

function client ({ port, holdMs }) {
  return new Promise((resolve) => {
    const started = performance.now()
    let latencyMs = null
    let done = false
    let noise = null
    let duplex = null
    let timer = setTimeout(finish, HANDSHAKE_TIMEOUT_MS)
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder', {
      perMessageDeflate: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS
    })
    ws.on('error', finish)
    ws.once('close', finish)
    duplex = createWebSocketStream(ws)
    duplex.on('error', finish)
    noise = new NoiseSecretStream(true, duplex, { keyPair: HyperDHT.keyPair() })
    noise.on('error', finish)
    noise.once('close', finish)
    noise.once('connect', () => {
      if (done) return
      try {
        Hypercore.createProtocolStream(noise, { keepAlive: true })
        attachAdmission(noise, {
          role: 'member',
          have: [],
          onclose: finish,
          onmessage: (msg) => {
            if (done || msg.type !== 'hello') return
            if (msg.role !== 'seeder') return finish()
            // HTTP 101 and Noise alone are not admission: wait for this hello.
            latencyMs = performance.now() - started
            clearTimeout(timer)
            timer = setTimeout(finish, holdMs)
          }
        })
      } catch {
        finish()
      }
    })

    function finish () {
      if (done) return
      done = true
      clearTimeout(timer)
      if (noise) noise.destroy()
      if (duplex) duplex.destroy()
      ws.terminate()
      resolve(latencyMs)
    }
  })
}

function sampleHealth (port) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => finish(null), 1000)
    const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('error', () => finish(null))
      res.on('aborted', () => finish(null))
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 65536) finish(null)
      })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (res.statusCode !== 200 || !data ||
              !Number.isSafeInteger(data.connections) || data.connections < 0 ||
              !Number.isSafeInteger(data.external) || data.external < 0) return finish(null)
          finish({ connections: data.connections, external: data.external })
        } catch {
          finish(null)
        }
      })
    })
    req.on('error', () => finish(null))

    function finish (value) {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      resolve(value)
    }
  })
}

function monitorHealth (port) {
  const maxima = { samples: 0, errors: 0, connections: null, external: null }
  let pending = null
  function sample () {
    if (pending) return
    pending = sampleHealth(port).then((counts) => {
      if (counts) {
        maxima.samples++
        maxima.connections = Math.max(maxima.connections ?? 0, counts.connections)
        maxima.external = Math.max(maxima.external ?? 0, counts.external)
      } else {
        maxima.errors++
      }
      pending = null
    })
  }
  sample()
  const timer = setInterval(sample, 1000)
  return async () => {
    clearInterval(timer)
    await pending
    return maxima
  }
}

function latencyStats (latencies) {
  latencies.sort((a, b) => a - b)
  const percentile = (p) => latencies.length === 0
    ? null
    : Math.round(latencies[Math.ceil(latencies.length * p) - 1] * 100) / 100
  return { p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) }
}

async function main () {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(USAGE + '\n')
    return
  }
  // Validate the entire invocation before opening any WebSocket or health socket.
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    process.stderr.write(USAGE + '\n')
    process.exitCode = 2
    return
  }
  const stopHealth = options.healthPort === undefined ? null : monitorHealth(options.healthPort)
  let results
  let health
  try {
    results = await Promise.all(Array.from({ length: options.clients }, () => client(options)))
  } finally {
    if (stopHealth) health = await stopHealth()
  }
  const latencies = results.filter((value) => value !== null)
  const report = {
    description: DESCRIPTION,
    attempted: options.clients,
    opened: latencies.length,
    refused: options.clients - latencies.length,
    handshakeMs: latencyStats(latencies)
  }
  if (health) report.health = health
  if (options.json) {
    process.stdout.write(JSON.stringify(report) + '\n')
    return
  }
  const value = (n) => n === null ? 'indisponível' : String(n)
  process.stdout.write(DESCRIPTION + '\n' +
    'Tentativas: ' + report.attempted + '; admitidas: ' + report.opened + '; recusadas: ' + report.refused + '.\n' +
    'Latência até a admissão (ms): p50 ' + value(report.handshakeMs.p50) +
    '; p95 ' + value(report.handshakeMs.p95) + '; máxima ' + value(report.handshakeMs.max) + '.\n')
  if (health) {
    process.stdout.write('Saúde (máximos amostrados a cada segundo): conexões ' + value(health.connections) +
      '; externas ' + value(health.external) + '; amostras ' + health.samples + '; falhas ' + health.errors + '.\n')
  }
}

main().catch(() => {
  process.stderr.write('erro: não foi possível concluir a medição de conexões ociosas.\n')
  process.exitCode = 1
})
