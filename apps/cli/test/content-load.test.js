'use strict'

// apps/cli/scripts/content-load.js: argument parsing, percentile math, the
// loopback-only refusals, and a short real run on a local testnet that
// leaves no socket and no temporary directory behind.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { spawn } = require('node:child_process')
const { parseArgs, checkBootstrap, percentile, summary, runContentLoad, httpGet, measureStartup, startupStep, timedOp, formatReport, ContentLoadUsageError, OPERATIONS } = require('../scripts/content-load')
const { testnet } = require('./helpers/net')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'content-load.js')

function run (t, args) {
  const child = spawn(process.execPath, [SCRIPT, ...args])
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
  t.teardown(async () => {
    child.kill('SIGKILL')
    await exited
  }, { force: true })
  return exited
}

test('content-load: argument parsing', (t) => {
  const d = parseArgs([])
  t.is(d.clients, 8)
  t.is(d.durationMs, 30000)
  t.is(d.rttMs, 0)
  t.is(d.httpRttMs, 0)
  t.alike([d.maxExternal, d.mediaRate, d.mediaBurst, d.mediaInFlight, d.indexRate, d.indexBurst], [32, 64, 128, 16, 32, 64])
  const limits = parseArgs(['--max-external', '4', '--media-rate', '2', '--media-burst', '3', '--media-in-flight', '1', '--index-rate', '5', '--index-burst', '6'])
  t.alike([limits.maxExternal, limits.mediaRate, limits.mediaBurst, limits.mediaInFlight, limits.indexRate, limits.indexBurst], [4, 2, 3, 1, 5, 6])
  t.is(parseArgs(['--rtt-ms', '100']).httpRttMs, 100)
  t.is(parseArgs(['--http-rtt-ms', '0', '--rtt-ms', '100']).httpRttMs, 0)
  t.is(parseArgs(['--rtt-ms', '100', '--http-rtt-ms', '50']).httpRttMs, 50)
  t.alike(d.datasetSize, { members: 20, blocksPerMember: 40 })
  t.is(d.inventory, 0)
  t.is(d.discovery, true)
  t.is(d.host, '127.0.0.1')
  t.is(d.json, false)
  t.is(parseArgs(['--no-discovery']).discovery, false)
  t.alike([d.names, d.namesMode], [0, 'batch'])
  t.alike([parseArgs(['--names', '25', '--names-mode', 'single']).names, parseArgs(['--names', '25', '--names-mode', 'single']).namesMode], [25, 'single'])

  const o = parseArgs(['--clients', '64', '--duration-ms', '1000', '--rtt-ms', '2000', '--dataset-size', '3x9', '--inventory', '4096', '--host', '::1', '--json'])
  t.is(o.clients, 64)
  t.is(o.durationMs, 1000)
  t.is(o.rttMs, 2000)
  t.alike(o.datasetSize, { members: 3, blocksPerMember: 9 })
  t.is(o.inventory, 4096)
  t.is(o.host, '::1')
  t.is(o.json, true)

  const bad = [
    ['--clients', '0'], ['--clients', '65'], ['--clients', '-1'], ['--clients', '1.5'], ['--clients'],
    ['--http-rtt-ms', '2001'], ['--http-rtt-ms', '-1'], ['--http-rtt-ms'],
    ['--max-external', '0'], ['--media-rate', '-1'], ['--media-burst', '0'],
    ['--media-in-flight', '0'], ['--index-rate', '1.5'], ['--index-burst', '0'],
    ['--duration-ms', '999'], ['--duration-ms', '600001'], ['--rtt-ms', '2001'], ['--inventory', '4097'],
    ['--dataset-size', '0x10'], ['--dataset-size', '10'], ['--dataset-size', '3x2'],
    ['--names', '33'], ['--names', '-1'], ['--names-mode', 'x'], ['--names-mode'], ['--names', '1', '--names', '2'],
    ['--json', '--json'], ['--no-discovery', '--no-discovery'], ['--clients', '2', '--clients', '3'], ['--url', 'ws://x'], ['--clients=2']
  ]
  for (const args of bad) t.exception(() => parseArgs(args), ContentLoadUsageError, 'recusa ' + args.join(' '))
})

test('content-load: loopback only', async (t) => {
  for (const host of ['0.0.0.0', 'localhost', '10.0.0.1', '::', 'example.com', '127.0.0.2']) {
    t.exception(() => parseArgs(['--host', host]), ContentLoadUsageError, 'host ' + host)
  }
  t.alike(checkBootstrap(['127.0.0.1:49737']), ['127.0.0.1:49737'])
  for (const list of [[], ['10.0.0.1:49737'], ['localhost:1'], ['127.0.0.1:0'], ['127.0.0.1:70000'], ['127.0.0.1']]) {
    t.exception(() => checkBootstrap(list), ContentLoadUsageError, 'bootstrap ' + JSON.stringify(list))
  }
  await t.exception(httpGet({ host: 'example.com' }), ContentLoadUsageError, 'HTTP recusa host externo antes da conexão')
  await t.exception(runContentLoad({ host: '0.0.0.0' }), ContentLoadUsageError, 'runContentLoad recusa host externo')
  await t.exception(runContentLoad({ bootstrap: ['10.0.0.1:49737'] }), ContentLoadUsageError, 'runContentLoad recusa DHT externa')

  const r = await run(t, ['--host', 'endereco-proibido', '--json'])
  t.is(r.code, 2)
  t.is(r.stdout, '')
  t.ok(r.stderr.includes('uso: '), 'uso em português')
  t.absent(r.stderr.includes('endereco-proibido'), 'o valor recusado não é reproduzido')
})

test('content-load: percentile and summary', (t) => {
  t.is(percentile([], 0.5), null)
  t.is(percentile([7], 0.5), 7)
  t.is(percentile([7], 0.95), 7)
  const xs = Array.from({ length: 100 }, (_, i) => i + 1)
  t.is(percentile(xs, 0.5), 50)
  t.is(percentile(xs, 0.95), 95)
  t.is(percentile(xs, 1), 100)
  t.is(percentile([1, 2, 3, 4], 0.5), 2)
  t.is(percentile([1, 2, 3, 4], 0.95), 4)

  const s = summary([
    { ms: 3.333, failure: null },
    { ms: 1, failure: null },
    { ms: 2, failure: null },
    { ms: 50, failure: 'timeout' },
    { ms: 5, failure: '503' },
    { ms: 5, failure: '429' },
    { ms: 5, failure: '1013' },
    { ms: 5, failure: 'other' }
  ])
  t.is(s.count, 8)
  t.is(s.ok, 3)
  t.is(s.p50, 2)
  t.is(s.p95, 3.33)
  t.is(s.max, 3.33)
  t.alike(s.failures, { 1013: 1, 429: 1, 503: 1, timeout: 1, other: 1 })
  t.alike(summary([]), { count: 0, ok: 0, p50: null, p95: null, max: null, failures: { 1013: 0, 429: 0, 503: 0, timeout: 0, other: 0 } })
})

test('content-load: HTTP delays both directions and verifies media hashes', async (t) => {
  const body = Buffer.from('foto de teste')
  const sha256 = createHash('sha256').update(body).digest('hex')
  let receivedAt = null
  const server = http.createServer((req, res) => {
    receivedAt = performance.now()
    if (req.url === '/429' || req.url === '/503') res.statusCode = Number(req.url.slice(1))
    res.write(body.subarray(0, 4))
    res.end(body.subarray(4))
  })
  t.teardown(() => new Promise((resolve) => server.close(resolve)), { force: true })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const stats = { bytes: { media: 0, index: 0 } }
  const options = { host: '127.0.0.1', port: server.address().port, pathname: '/media', stats, kind: 'media', sha256 }
  const { httpRttMs } = parseArgs(['--rtt-ms', '100'])
  const startedAt = performance.now()
  const r = await httpGet({ ...options, rttMs: httpRttMs })
  const endedAt = performance.now()
  t.ok(endedAt - startedAt >= 100, 'GET leva pelo menos o RTT configurado')
  t.ok(receivedAt - startedAt >= 49, 'atraso antes de enviar o pedido')
  t.ok(endedAt - receivedAt >= 49, 'atraso antes de entregar a resposta')
  t.is(r.failure, null, 'hash correto aceito')
  t.is(r.bytes, body.length)
  t.is(stats.bytes.media, body.length)
  const wrong = await httpGet({ ...options, sha256: '0'.repeat(64) })
  t.is(wrong.failure, 'other', 'corpo com hash errado falha')
  t.is(summary([{ ms: 1, failure: wrong.failure }]).ok, 0, 'hash errado não conta como sucesso')
  t.is((await httpGet({ ...options, sha256: undefined })).failure, 'other', 'mídia sem hash não conta como verificada')
  for (const kind of ['media', 'index']) {
    for (const status of [429, 503]) {
      const r = await httpGet({ ...options, kind, pathname: '/' + status })
      t.is(r.failure, String(status), kind + ' preserva ' + status)
      t.is(summary([{ ms: 1, failure: r.failure }]).failures[status], 1)
    }
  }
})

test('content-load: first rows use the startup boundary before sweeps and connect', async (t) => {
  t.timeout(5000)
  const own = {}
  const stopped = new Map()
  const timers = []
  const pause = (ms) => new Promise((resolve) => timers.push(setTimeout(resolve, ms)))
  t.teardown(() => timers.forEach(clearTimeout), { force: true })
  const cached = { author: 'a', seq: 1 }
  const fresh = { author: 'b', seq: 2 }
  let connected
  const connecting = new Promise((resolve) => { connected = resolve })
  let reads = 0
  let syncFinished = false
  let firstReadDuringSync = false
  const web = {
    stopped,
    async request (op) {
      if (op === 'sync.start') {
        timers.push(setTimeout(() => startupStep(own, 'índice de réplicas'), 50))
        timers.push(setTimeout(() => {
          startupStep(own, 'conexão')
          connected()
        }, 100))
        timers.push(setTimeout(() => {
          syncFinished = true
          stopped.set(1, { reason: 'done', result: { ok: true } })
        }, 180))
        return { runId: 1 }
      }
      if (op === 'diary.peek') return { entries: [] }
      if (++reads === 1) {
        await pause(20)
        firstReadDuringSync = !syncFinished
        return { items: [cached] }
      }
      await connecting
      return { items: [cached, fresh] }
    }
  }
  const reader = { web, own, cached: new Set(['a:1']) }
  const timed = async (op, fn) => ({ failure: (await fn())?.failure || null })
  const { metrics, failure } = await measureStartup({ reader, timed, peek: { author: 'b', seqs: [2] } })
  t.is(failure, null)
  t.ok(firstReadDuringSync, 'feed lido antes do fim da sincronização')
  t.is(metrics.firstRowsMs, metrics.cachedRowsMs)
  t.ok(metrics.firstRowsMs < metrics.freshRowsMs, 'cache aparece antes das novas linhas')
  t.ok(metrics.freshRowsMs >= 99, 'novas linhas incluem a partida antes da conexão')
  t.ok(metrics.firstRowsMs < metrics.openMs, 'primeiro conteúdo precede a abertura completa')
  t.ok(metrics.sweepsMs >= 0, 'varreduras medidas separadamente')
  t.is(metrics.connectMs, null, 'não inventa duração sem abertura de socket')
  t.alike([...reader.cached], ['a:1', 'b:2'])
  t.is(own.startup, null, 'observação encerrada')
})

test('content-load: a 2-client 3-second run ends clean', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  let root = null
  const report = await runContentLoad({ clients: 2, durationMs: 3000, rttMs: 20, maxExternal: 48, mediaRate: 128, mediaBurst: 256, mediaInFlight: 8, indexRate: 64, indexBurst: 128, datasetSize: { members: 3, blocksPerMember: 8 }, bootstrap, onRoot: (dir) => { root = dir } })
  t.ok(root !== null, 'diretório temporário criado')
  t.absent(fs.existsSync(root), 'diretório temporário removido')
  t.is(report.socketsLeft, 0, 'nenhum socket aberto no fim')
  t.ok(report.description.includes('loopback'), 'diz que é medição em loopback')
  t.ok(report.description.includes('não é uma medida de capacidade'), 'não é alegação de capacidade')
  t.is(report.clients, 2)
  t.is(report.discovery, true, 'semeador com descoberta por padrão')
  t.ok(report.opens >= 2, 'cada leitor abriu ao menos uma vez')
  t.alike(Object.keys(report.operations), OPERATIONS)
  for (const op of ['sync.start', 'feed.read', 'profile.read', 'peek.read', 'notices.list', 'diary.peek', 'index.counts', 'index.member', 'first-content', 'open']) {
    t.ok(report.operations[op].count >= 2, op + ' medido')
  }
  t.ok(report.operations['feed.read'].ok >= 2, 'feed.read respondeu')
  t.is(report.httpRttMs, 20, 'HTTP herda o RTT programático')
  t.alike(report.capacity, { maxExternal: 48, mediaRate: 128, mediaBurst: 256, mediaInFlight: 8, indexRate: 64, indexBurst: 128 })
  t.is(report.firstContent.boundary, 'sync.start')
  t.ok(report.firstContent.freshRowsMs.count > 0, 'novas linhas medidas')
  t.ok(report.firstContent.sweepsMs.count >= 2, 'varreduras medidas')
  t.ok(report.firstContent.connectMs.count >= 2, 'conexões medidas')
  t.ok(report.operations['first-content'].p50 < report.operations.open.p50, 'conteúdo chega antes da abertura que aguarda a sincronização')
  const printed = formatReport(report)
  t.ok(printed.includes('maxExternal 48; mediaRate 128; mediaBurst 256; mediaInFlight 8; indexRate 64; indexBurst 128'))
  t.ok(printed.includes('429 0'))
  t.ok(printed.includes('cachedRowsMs:'))
  t.ok(report.peakExternal >= 1, 'pico de sockets externos amostrado')
  t.ok(report.bytesReceived.seeder > 0, 'bytes do semeador contados')
  t.ok(report.rssMiB.peak > 0)
  t.absent(/[0-9a-f]{64}|127\.0\.0\.1|wss?:\/\//.test(JSON.stringify(report)), 'sem chaves nem endereços')
  t.absent(JSON.stringify(report).includes(String.fromCharCode(0x2014)), 'sem travessão')
})

test('content-load: names step, batch GETs against one GET per author', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const base = { clients: 1, durationMs: 1000, maxExternal: 48, mediaRate: 128, mediaBurst: 256, mediaInFlight: 8, indexRate: 1000, indexBurst: 1000, datasetSize: { members: 3, blocksPerMember: 8 }, bootstrap, names: 3 }
  const batch = await runContentLoad({ ...base, namesMode: 'batch' })
  t.is(batch.names.mode, 'batch')
  t.ok(batch.opens >= 1)
  t.ok(batch.operations['index.members'].ok >= batch.opens, 'um GET em lote por abertura (3 autores)')
  t.is(batch.operations['index.member'].count, 0, 'sem GET por autor')
  t.is(batch.operations.names.ok, batch.opens, 'etapa dos nomes medida por abertura')
  t.is(batch.operations['index.members'].failures.other, 0, 'a rota em lote responde 200')
  const single = await runContentLoad({ ...base, namesMode: 'single' })
  t.is(single.operations['index.members'].count, 0)
  t.is(single.operations['index.member'].count, 3 * single.opens, 'um GET por autor')
  t.is(single.operations.names.ok, single.opens)
  t.ok(single.indexRequests >= 3 * single.opens, 'pedidos ao índice contados')
  t.ok(batch.indexRequests < single.indexRequests / 1.5 || batch.opens > single.opens, 'o lote usa menos pedidos por abertura')
  t.ok(formatReport(batch).includes('Nomes por abertura: 3 autores, modo batch'))
})

test('content-load: a failed startup peek fails the open', async (t) => {
  t.timeout(5000)
  const own = {}
  const stopped = new Map()
  const web = {
    stopped,
    async request (op) {
      if (op === 'sync.start') {
        setTimeout(() => stopped.set(1, { reason: 'done', result: { ok: true } }), 30)
        return { runId: 1 }
      }
      if (op === 'diary.peek') throw Object.assign(new Error('x'), { code: 'TIMEOUT' })
      return { items: [] }
    }
  }
  const timed = async (op, fn) => {
    try { return { failure: (await fn())?.failure || null } } catch (err) { return { failure: err.code === 'TIMEOUT' ? 'timeout' : 'other' } }
  }
  const { failure } = await measureStartup({ reader: { web, own, cached: new Set() }, timed, peek: { author: 'a', seqs: [1] } })
  t.is(failure, 'timeout', 'peek com falha torna a abertura uma falha')
})

test('content-load: one feed.read sample per open however long sync.start takes', async (t) => {
  t.timeout(5000)
  const stopped = new Map()
  const samples = new Map(OPERATIONS.map((op) => [op, []]))
  let reads = 0
  const web = {
    stopped,
    async request (op) {
      if (op === 'sync.start') {
        setTimeout(() => stopped.set(1, { reason: 'done', result: { ok: true } }), 120)
        return { runId: 1 }
      }
      if (op === 'diary.peek') return { entries: [] }
      reads++
      return { items: [] }
    }
  }
  const reader = { web, own: { closes1013: 0 }, cached: new Set() }
  const timed = (op, fn) => timedOp(samples, reader, op, fn)
  await measureStartup({ reader, timed, peek: { author: 'a', seqs: [1] } })
  t.ok(reads >= 3, 'o feed foi consultado várias vezes durante a sincronização')
  t.is(samples.get('feed.read').length, 1, 'uma amostra de feed.read por abertura')
  t.is(samples.get('sync.start').length, 1)
})

test('content-load: a 1013 during overlapping operations is not blamed on a concurrent one', async (t) => {
  t.timeout(5000)
  const samples = new Map(OPERATIONS.map((op) => [op, []]))
  const reader = { own: { closes1013: 0 } }
  const gate = {}
  const wait = new Promise((resolve) => { gate.open = resolve })
  const slow = timedOp(samples, reader, 'sync.start', async () => { await wait })
  const failing = timedOp(samples, reader, 'diary.peek', async () => {
    reader.own.closes1013++
    return { failure: 'other' }
  })
  await failing
  gate.open()
  await slow
  t.is(samples.get('diary.peek')[0].failure, 'other', 'sobreposta: mantém a própria falha')
  t.is(samples.get('sync.start')[0].failure, null)
  await timedOp(samples, reader, 'peek.read', async () => {
    reader.own.closes1013++
    return { failure: 'other' }
  })
  t.is(samples.get('peek.read')[0].failure, '1013', 'sozinha: 1013 atribuído')
  await timedOp(samples, reader, 'notices.list', async () => ({ failure: 'other' }))
  t.is(samples.get('notices.list')[0].failure, 'other', 'sem fechamento 1013: mantém a falha')
})
