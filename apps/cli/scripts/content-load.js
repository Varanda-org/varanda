#!/usr/bin/env node
'use strict'

// Development-only loopback measurement of what opening the app costs:
//   node apps/cli/scripts/content-load.js [--clients 8] [--duration-ms 30000] [--rtt-ms 0]
//     [--dataset-size 20x40] [--inventory 0] [--host 127.0.0.1] [--json]
// It starts its OWN temporary installation on this machine (a loopback
// hyperdht testnet, an in-memory association and issuer, a certified seeder
// and its WebSocket listener on an ephemeral port), fills it with
// ./lab-dataset.js, and drives N in-process browser-node sessions through a
// "phone open": sync.start, feed.read, profile.read, peek.read,
// notices.list, one GET /index/counts with 27 refs and 4 GET /media, over
// and over until --duration-ms ends. --rtt-ms delays every frame of the
// readers' WebSockets by half of it in each direction. --inventory pads the
// served diaries (small real diaries) up to that many.
// Never reads operator configuration, the environment or a credential: every
// key is made here, in memory or in the temporary directory, and removed at
// the end, on success and on failure. Nothing it prints is a capacity claim.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const { parseDatasetSize } = require('../lib/lab-dataset-plan')

const DESCRIPTION = 'Medição somente em loopback, numa instalação temporária deste computador, para desenvolvimento; não é uma medida de capacidade.'
const USAGE = 'uso: node apps/cli/scripts/content-load.js [--clients <1..64> (padrão: 8)] [--duration-ms <1000..600000> (padrão: 30000)] ' +
  '[--rtt-ms <0..2000> (padrão: 0)] [--dataset-size <membros>x<blocos> (padrão: 20x40)] [--inventory <0..4096> (padrão: 0)] ' +
  '[--host 127.0.0.1|::1] [--json]. ' + DESCRIPTION

const LOOPBACK = new Set(['127.0.0.1', '::1'])
const OPERATIONS = ['sync.start', 'feed.read', 'profile.read', 'peek.read', 'notices.list', 'index.counts', 'media']
const COUNT_REFS = 27
const MEDIA_PER_OPEN = 4
const OP_TIMEOUT_MS = 30000
const SYNC_TIMEOUT_MS = 20000
const HTTP_TIMEOUT_MS = 10000
const SAMPLE_MS = 100
const CLOSE_WAIT_MS = 5000
const MAX_INVENTORY = 4096
const PAD_CHUNK = 1000

class ContentLoadUsageError extends Error {}

// argv -> options; throws ContentLoadUsageError (never echoing the value).
function parseArgs (argv) {
  const options = { clients: 8, durationMs: 30000, rttMs: 0, datasetSize: { members: 20, blocksPerMember: 40 }, inventory: 0, host: '127.0.0.1', json: false }
  const numbers = new Map([
    ['--clients', ['clients', 1, 64]],
    ['--duration-ms', ['durationMs', 1000, 600000]],
    ['--rtt-ms', ['rttMs', 0, 2000]],
    ['--inventory', ['inventory', 0, MAX_INVENTORY]]
  ])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) throw new ContentLoadUsageError('opção repetida')
    seen.add(flag)
    if (flag === '--json') {
      options.json = true
      continue
    }
    if (flag === '--help' || flag === '-h') {
      options.help = true
      continue
    }
    const value = argv[++i]
    if (typeof value !== 'string') throw new ContentLoadUsageError('falta o valor de uma opção')
    if (flag === '--dataset-size') {
      const size = parseDatasetSize(value)
      if (size === null) throw new ContentLoadUsageError('--dataset-size deve ser <membros>x<blocos>, por exemplo 20x40')
      options.datasetSize = size
      continue
    }
    if (flag === '--host') {
      if (!LOOPBACK.has(value)) throw new ContentLoadUsageError('--host deve ser 127.0.0.1 ou ::1')
      options.host = value
      continue
    }
    const field = numbers.get(flag)
    if (!field) throw new ContentLoadUsageError('opção desconhecida')
    if (!/^[0-9]{1,7}$/.test(value)) throw new ContentLoadUsageError('valor inválido')
    const [name, min, max] = field
    const number = Number(value)
    if (number < min || number > max) throw new ContentLoadUsageError('valor fora do intervalo')
    options[name] = number
  }
  return options
}

// Each entry must be 127.0.0.1:<port>: the harness never joins another DHT.
function checkBootstrap (list) {
  if (!Array.isArray(list) || list.length === 0) throw new ContentLoadUsageError('bootstrap vazio')
  for (const entry of list) {
    const m = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(String(entry))
    if (m === null || Number(m[1]) < 1 || Number(m[1]) > 65535) throw new ContentLoadUsageError('bootstrap deve apontar só para 127.0.0.1:<porta>')
  }
  return list
}

// Nearest rank over an ascending array; null when empty.
function percentile (sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * p)))
  return sorted[rank - 1]
}

const round = (n) => n === null ? null : Math.round(n * 100) / 100

// samples: [{ ms, failure: null | '1013' | '503' | 'timeout' | 'other' }].
function summary (samples) {
  const ok = samples.filter((s) => s.failure === null).map((s) => s.ms).sort((a, b) => a - b)
  const failures = { 1013: 0, 503: 0, timeout: 0, other: 0 }
  for (const s of samples) if (s.failure !== null) failures[s.failure]++
  return {
    count: samples.length,
    ok: ok.length,
    p50: round(percentile(ok, 0.5)),
    p95: round(percentile(ok, 0.95)),
    max: round(percentile(ok, 1)),
    failures
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout (promise, ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('tempo esgotado'), { code: 'TIMEOUT' })), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// A WebSocket-like facade (the interface packages/web-member/lib/ws-stream.js
// drives) over Node's ws, delaying every frame by rttMs / 2 each way. Same
// delay for every frame, and Node fires timers of one duration in order, so
// frames never reorder. Counts received bytes and 1013 closes (in stats and,
// when given, in own: one reader's count, so a failure is blamed on its own link).
function delayedSocketFactory ({ rttMs, stats, sockets, own = null }) {
  const { WebSocket } = require('ws')
  const half = Math.floor(rttMs / 2)
  const later = (fn) => { if (half === 0) fn(); else setTimeout(fn, half) }
  return function createSocket (url) {
    const ws = new WebSocket(url, { perMessageDeflate: false })
    sockets.add(ws)
    const listeners = new Map([['open', new Set()], ['message', new Set()], ['close', new Set()], ['error', new Set()]])
    const facade = {
      binaryType: 'arraybuffer',
      readyState: 0,
      addEventListener (name, fn) { if (listeners.has(name)) listeners.get(name).add(fn) },
      removeEventListener (name, fn) { if (listeners.has(name)) listeners.get(name).delete(fn) },
      send (bytes) {
        later(() => { if (ws.readyState === 1) ws.send(bytes) })
      },
      close (code) {
        if (facade.readyState >= 2) return
        facade.readyState = 2
        later(() => { try { ws.close(code) } catch { ws.terminate() } })
      }
    }
    const dispatch = (name, event) => {
      for (const fn of [...listeners.get(name)]) {
        try { fn(event) } catch {}
      }
    }
    ws.binaryType = 'arraybuffer'
    ws.on('open', () => later(() => {
      if (facade.readyState !== 0) return
      facade.readyState = 1
      dispatch('open', { type: 'open' })
    }))
    ws.on('message', (data, isBinary) => {
      stats.bytes.seeder += data.byteLength !== undefined ? data.byteLength : data.length
      const payload = isBinary ? data : Buffer.from(data).toString('utf8')
      later(() => dispatch('message', { type: 'message', data: payload }))
    })
    ws.on('error', () => later(() => dispatch('error', { type: 'error' })))
    ws.on('close', (code) => {
      sockets.delete(ws)
      if (code === 1013) {
        stats.closes1013++
        if (own !== null) own.closes1013++
      }
      later(() => {
        facade.readyState = 3
        dispatch('close', { type: 'close', code })
      })
    })
    return facade
  }
}

// GET one loopback path -> { status, bytes } or a failure reason.
function httpGet ({ host, port, pathname, stats, kind }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const req = http.request({ host, port, method: 'GET', path: pathname, headers: { host: (host === '::1' ? '[::1]' : host) + ':' + port }, agent: false }, (res) => {
      let bytes = 0
      res.on('data', (chunk) => { bytes += chunk.length })
      res.on('end', () => {
        stats.bytes[kind] += bytes
        finish({ status: res.statusCode, bytes })
      })
      res.on('error', () => finish({ failure: 'other' }))
      res.on('aborted', () => finish({ failure: 'other' }))
    })
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy()
      finish({ failure: 'timeout' })
    })
    req.on('error', () => finish({ failure: 'other' }))
    req.end()
  })
}

function failureOf (err) {
  if (err && (err.code === 'TIMEOUT' || err.code === 'tempo')) return 'timeout'
  return 'other'
}

// The client side of a browser node, as lab-dataset.js wires it.
async function connect (node, createClient, parseMessage, MAX_MESSAGE) {
  const stopped = new Map()
  let port = null
  const client = createClient({
    send: (message, text) => queueMicrotask(() => { if (port !== null) port.receive(text) }),
    timeoutMs: OP_TIMEOUT_MS
  })
  port = node.connect((text) => queueMicrotask(() => {
    const parsed = parseMessage(text, MAX_MESSAGE)
    if (parsed.ok) client.receive(parsed.value)
  }), { onClose: () => client.close() })
  client.on('sync.stopped', (data) => {
    if (data && data.runId !== undefined) stopped.set(data.runId, data)
  })
  await client.request('session.open', {})
  return { stopped, request: (method, params = {}) => client.request(method, params) }
}

// runContentLoad(options) -> report. options: parseArgs's fields plus, for
// tests, bootstrap (127.0.0.1 entries; else the harness starts its own
// testnet), onRoot(dir) (the temporary directory, once made) and log(line).
async function runContentLoad (opts) {
  const options = { ...parseArgs([]), ...opts }
  if (!LOOPBACK.has(options.host)) throw new ContentLoadUsageError('--host deve ser 127.0.0.1 ou ::1')
  const givenBootstrap = options.bootstrap === undefined || options.bootstrap === null ? null : checkBootstrap(options.bootstrap)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false

  // Loaded only now, so a refused argument never touches the network.
  const b4a = require('b4a')
  const crypto = require('hypercore-crypto')
  const { createClient, parseMessage, MAX_MESSAGE } = require('@varanda/rpc')
  const { createIssuedCert, createUsernameRecord, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
  const { Seeder } = require('@varanda/core/lib/seeder')
  const { createBrowserNode } = require('@varanda/web-member/lib/node')
  const { memoryNodeStorage } = require('@varanda/web-member/lib/node-storage')
  const { planDataset, MIN_BLOCKS } = require('../lib/lab-dataset-plan')
  const { startSeedWs } = require('../lib/seed-ws')
  const { runDataset } = require('./lab-dataset')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-carga-'))
  if (typeof options.onRoot === 'function') options.onRoot(root)
  const cleanups = []
  const sockets = new Set()
  const stats = { bytes: { seeder: 0, index: 0, media: 0 }, closes1013: 0 }
  const samples = new Map(OPERATIONS.map((op) => [op, []]))
  const internal = []
  const readers = []
  let sampler = null
  let report = null

  try {
    let bootstrap = givenBootstrap
    if (bootstrap === null) {
      const testnet = await require('hyperdht/testnet')(3, { host: '127.0.0.1' })
      cleanups.push(() => testnet.destroy())
      bootstrap = testnet.bootstrap.map(({ port }) => '127.0.0.1:' + port)
    }

    const assocKp = generateAssociationKeyPair()
    const association = b4a.toString(assocKp.publicKey, 'hex')
    const seedDir = path.join(root, 'seeder')
    Seeder.ensureConfig(seedDir, association)
    const { publicKey: seederKey } = Seeder.createKey(seedDir)
    const certFile = path.join(root, 'seeder-cert.json')
    fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
    Seeder.addCert(seedDir, certFile, association)
    const seeder = new Seeder({ dataDir: seedDir, associationKey: association, bootstrap, host: '127.0.0.1' })
    const ws = await startSeedWs({ host: options.host, port: 0, seeder })
    cleanups.push(() => ws.close())
    await seeder.start()
    cleanups.push(() => seeder.close())
    const wsHost = options.host === '::1' ? '[::1]' : '127.0.0.1'
    const seederWsUrl = 'ws://' + wsHost + ':' + ws.port + '/seeder'
    const origin = 'http://' + wsHost + ':' + ws.port
    log('semeador temporário no ar')

    const issuerKp = crypto.keyPair()
    const issuer = { keyPair: issuerKp, cert: createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex') }, assocKp) }
    const heldLength = (key) => {
      const served = seeder._served.get(key)
      return served && served.core ? served.core.contiguousLength : 0
    }

    const { members, blocksPerMember } = options.datasetSize
    const plan = planDataset({ seed: 'carga', members, blocksPerMember })
    const keep = Math.min(options.clients, members)
    const dataset = await runDataset({ seederWsUrl, origin, association, issuer, plan, root: path.join(root, 'dataset'), log, heldLength, keep, exposeClients: true })
    cleanups.push(() => dataset.close())
    log('conjunto de dados pronto: ' + dataset.members.length + ' diários')

    // A signal during the setup stops it here; the finally cleans up.
    const pad = Math.max(0, options.inventory - members - options.clients)
    for (let done = 0, pass = 0; done < pad && !shouldStop(); pass++) {
      const n = Math.min(PAD_CHUNK, pad - done)
      const padPlan = planDataset({ seed: 'carga-inventario-' + pass, members: n, blocksPerMember: MIN_BLOCKS, photoShare: 0, communities: 0 })
      const padded = await runDataset({ seederWsUrl, origin, association, issuer, plan: padPlan, root: path.join(root, 'inventory-' + pass), log, heldLength, keep: 0 })
      await padded.close()
      done += n
      log('inventário: ' + (members + done) + ' diários servidos')
    }

    if (shouldStop()) throw new Error('interrompido')
    // Authors stay online, as on a real installation, while readers open.
    for (const c of dataset.clients) await c.web.request('sync.start', {}).catch(() => {})

    const keys = dataset.members.map((m) => m.key)
    const refs = []
    for (const m of plan.members) {
      for (const a of m.actions) if (a.kind === 'post' || a.kind === 'photo' || a.kind === 'reply' || a.kind === 'quote') refs.push(keys[m.index] + ':' + a.seq)
    }
    const mediaPool = new Map()

    for (let i = 0; i < options.clients; i++) {
      const own = { closes1013: 0 }
      const createSocket = delayedSocketFactory({ rttMs: options.rttMs, stats, sockets, own })
      const node = createBrowserNode({
        storage: memoryNodeStorage(),
        association,
        seederUrl: seederWsUrl,
        createSocket,
        onInternalError: (err) => internal.push(err),
        writeGate: false
      })
      readers.push({ node, own, opens: 0 })
      const id = crypto.keyPair()
      await node.setKeyPair(id, { media: crypto.keyPair(), prf: crypto.randomBytes(32) })
      const web = await connect(node, createClient, parseMessage, MAX_MESSAGE)
      readers[i].web = web
      const { publicKey } = await web.request('identity.create')
      const date = new Date().toISOString()
      await web.request('cert.add', { cert: createIssuedCert({ member: publicKey, date }, issuer.keyPair, issuer.cert) })
      await web.request('username.add', { record: createUsernameRecord({ member: publicKey, username: 'leitor_' + (i + 1), date }, issuer.keyPair, issuer.cert) })
      await web.request('profile.set', { name: 'Leitor ' + (i + 1), bio: '' })
      for (const key of keys) await web.request('follow.add', { key })
    }
    log(options.clients + ' leitores prontos; medindo por ' + options.durationMs + ' ms')

    const peak = { external: 0, rss: 0 }
    const sample = () => {
      try { peak.external = Math.max(peak.external, seeder.stats().external) } catch {}
      peak.rss = Math.max(peak.rss, process.memoryUsage().rss)
    }
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    sample()
    sampler = setInterval(sample, SAMPLE_MS)

    const httpHost = options.host
    async function timed (reader, op, fn) {
      const t0 = performance.now()
      const before1013 = reader.own.closes1013
      let failure = null
      try {
        const r = await withTimeout(fn(), OP_TIMEOUT_MS)
        if (r && r.failure) failure = r.failure
      } catch (err) {
        failure = failureOf(err)
      }
      if (failure === 'other' && reader.own.closes1013 > before1013) failure = '1013'
      samples.get(op).push({ ms: performance.now() - t0, failure })
    }

    async function phoneOpen (reader, n) {
      const { web } = reader
      await timed(reader, 'sync.start', async () => {
        const { runId } = await web.request('sync.start', { once: true, timeoutMs: SYNC_TIMEOUT_MS })
        const deadline = Date.now() + SYNC_TIMEOUT_MS + 5000
        while (Date.now() < deadline) {
          const ev = web.stopped.get(runId)
          if (ev) {
            web.stopped.delete(runId)
            if (ev.reason === 'done' && ev.result && ev.result.ok === true) return null
            return { failure: ev.reason === 'timeout' ? 'timeout' : 'other' }
          }
          await sleep(20)
        }
        return { failure: 'timeout' }
      })
      let items = []
      await timed(reader, 'feed.read', async () => {
        const r = await web.request('feed.read', {})
        items = Array.isArray(r.items) ? r.items : []
      })
      for (const it of items) {
        if (!it || !Array.isArray(it.media)) continue
        for (const d of it.media) {
          if (d && /^[0-9a-f]{64}$/.test(it.author) && /^[0-9a-f]{64}$/.test(d.core) && Number.isSafeInteger(d.start) && Number.isSafeInteger(d.blocks)) {
            if (mediaPool.size < 256) mediaPool.set(it.author + '/' + d.core + '/' + d.start + '/' + d.blocks, true)
          }
        }
      }
      const authors = [...new Set(items.map((it) => it && it.author).filter((a) => /^[0-9a-f]{64}$/.test(a)))].slice(0, 27)
      await timed(reader, 'profile.read', () => web.request('profile.read', { authors: authors.length > 0 ? authors : keys.slice(0, 27) }))
      await timed(reader, 'peek.read', () => web.request('peek.read', {}))
      await timed(reader, 'notices.list', () => web.request('notices.list', {}))
      const start = (n * COUNT_REFS) % Math.max(1, refs.length)
      const window = [...new Set([...refs.slice(start), ...refs.slice(0, start)].slice(0, COUNT_REFS))]
      if (window.length > 0) {
        await timed(reader, 'index.counts', async () => {
          const r = await httpGet({ host: httpHost, port: ws.port, pathname: '/index/counts/' + window.join(','), stats, kind: 'index' })
          if (r.failure) return r
          return r.status === 200 ? null : { failure: r.status === 503 ? '503' : 'other' }
        })
      }
      const pool = [...mediaPool.keys()]
      for (let k = 0; k < Math.min(MEDIA_PER_OPEN, pool.length); k++) {
        const p = pool[(n * MEDIA_PER_OPEN + k) % pool.length]
        await timed(reader, 'media', async () => {
          const r = await httpGet({ host: httpHost, port: ws.port, pathname: '/media/' + p, stats, kind: 'media' })
          if (r.failure) return r
          return r.status === 200 ? null : { failure: r.status === 503 ? '503' : 'other' }
        })
      }
      reader.opens++
    }

    const measureStart = Date.now()
    const deadline = measureStart + options.durationMs
    await Promise.all(readers.map(async (reader) => {
      let n = 0
      do {
        await phoneOpen(reader, n++)
      } while (Date.now() < deadline && !shouldStop())
    }))
    const elapsedMs = Date.now() - measureStart

    clearInterval(sampler)
    sampler = null
    sample()
    loop.disable()
    const ns = (v) => Number.isFinite(v) ? round(v / 1e6) : null

    const operations = {}
    for (const op of OPERATIONS) operations[op] = summary(samples.get(op))
    report = {
      description: DESCRIPTION,
      clients: options.clients,
      durationMs: options.durationMs,
      elapsedMs,
      rttMs: options.rttMs,
      dataset: { members, blocksPerMember },
      inventory: { requested: options.inventory, served: seeder._served.size },
      opens: readers.reduce((a, r) => a + r.opens, 0),
      operations,
      closes1013: stats.closes1013,
      peakExternal: peak.external,
      eventLoopDelayMs: { p50: ns(loop.percentile(50)), p99: ns(loop.percentile(99)), max: ns(loop.max) },
      rssMiB: { peak: round(peak.rss / 1048576) },
      bytesReceived: { ...stats.bytes },
      internalErrors: internal.length,
      socketsLeft: null
    }
  } finally {
    if (sampler !== null) clearInterval(sampler)
    for (const r of readers) await r.node.close().catch(() => {})
    for (const fn of cleanups.reverse()) {
      try { await fn() } catch {}
    }
    const until = Date.now() + CLOSE_WAIT_MS
    while (sockets.size > 0 && Date.now() < until) await sleep(25)
    const left = sockets.size
    for (const s of sockets) s.terminate()
    sockets.clear()
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    if (report !== null) report.socketsLeft = left
  }
  return report
}

function formatReport (r) {
  const v = (n) => n === null ? 'indisponível' : String(n)
  const lines = [
    r.description,
    'Leitores: ' + r.clients + '; duração: ' + r.elapsedMs + ' ms; atraso de ida e volta simulado: ' + r.rttMs + ' ms; aberturas completas: ' + r.opens + '.',
    'Conjunto: ' + r.dataset.members + ' membros x ' + r.dataset.blocksPerMember + ' blocos; diários servidos: ' + r.inventory.served + '.'
  ]
  for (const [op, s] of Object.entries(r.operations)) {
    lines.push(op + ': ' + s.ok + '/' + s.count + ' ok; p50 ' + v(s.p50) + ' ms; p95 ' + v(s.p95) + ' ms; máxima ' + v(s.max) + ' ms; falhas: 1013 ' + s.failures[1013] +
      ', 503 ' + s.failures[503] + ', tempo esgotado ' + s.failures.timeout + ', outras ' + s.failures.other + '.')
  }
  lines.push('Fechamentos 1013: ' + r.closes1013 + '; pico de sockets externos no semeador: ' + r.peakExternal + '.')
  lines.push('Atraso do laço de eventos (ms): p50 ' + v(r.eventLoopDelayMs.p50) + '; p99 ' + v(r.eventLoopDelayMs.p99) + '; máximo ' + v(r.eventLoopDelayMs.max) + '. RSS máximo: ' + v(r.rssMiB.peak) + ' MiB.')
  lines.push('Bytes recebidos: semeador ' + r.bytesReceived.seeder + '; índice ' + r.bytesReceived.index + '; mídia ' + r.bytesReceived.media + '. Sockets abertos no fim: ' + r.socketsLeft + '.')
  return lines.join('\n') + '\n'
}

async function main () {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof ContentLoadUsageError)) throw err
    process.stderr.write('erro: ' + err.message + '\n' + USAGE + '\n')
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return
  }
  let stop = false
  const onSignal = () => { stop = true }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const report = await runContentLoad({
      ...options,
      shouldStop: () => stop,
      log: options.json ? () => {} : (line) => process.stderr.write('[carga] ' + line + '\n')
    })
    process.stdout.write(options.json ? JSON.stringify(report) + '\n' : formatReport(report))
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

if (require.main === module) {
  main().catch((err) => {
    const stopped = err && err.message === 'interrompido'
    process.stderr.write(stopped ? 'medição interrompida antes de começar.\n' : 'erro: não foi possível concluir a medição de carregamento.\n')
    process.exitCode = stopped ? 130 : 1
  }).finally(() => {
    setTimeout(() => process.exit(process.exitCode), 2000).unref()
  })
}

module.exports = { parseArgs, checkBootstrap, percentile, summary, runContentLoad, formatReport, delayedSocketFactory, ContentLoadUsageError, DESCRIPTION, OPERATIONS }
