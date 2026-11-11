'use strict'

// apps/cli/scripts/content-load.js: argument parsing, percentile math, the
// loopback-only refusals, and a short real run on a local testnet that
// leaves no socket and no temporary directory behind.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { parseArgs, checkBootstrap, percentile, summary, runContentLoad, ContentLoadUsageError, OPERATIONS } = require('../scripts/content-load')
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
  t.alike(d.datasetSize, { members: 20, blocksPerMember: 40 })
  t.is(d.inventory, 0)
  t.is(d.host, '127.0.0.1')
  t.is(d.json, false)

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
    ['--duration-ms', '999'], ['--duration-ms', '600001'], ['--rtt-ms', '2001'], ['--inventory', '4097'],
    ['--dataset-size', '0x10'], ['--dataset-size', '10'], ['--dataset-size', '3x2'],
    ['--json', '--json'], ['--clients', '2', '--clients', '3'], ['--url', 'ws://x'], ['--clients=2']
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
    { ms: 5, failure: '1013' },
    { ms: 5, failure: 'other' }
  ])
  t.is(s.count, 7)
  t.is(s.ok, 3)
  t.is(s.p50, 2)
  t.is(s.p95, 3.33)
  t.is(s.max, 3.33)
  t.alike(s.failures, { 1013: 1, 503: 1, timeout: 1, other: 1 })
  t.alike(summary([]), { count: 0, ok: 0, p50: null, p95: null, max: null, failures: { 1013: 0, 503: 0, timeout: 0, other: 0 } })
})

test('content-load: a 2-client 3-second run ends clean', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  let root = null
  const report = await runContentLoad({ clients: 2, durationMs: 3000, rttMs: 20, datasetSize: { members: 3, blocksPerMember: 8 }, bootstrap, onRoot: (dir) => { root = dir } })
  t.ok(root !== null, 'diretório temporário criado')
  t.absent(fs.existsSync(root), 'diretório temporário removido')
  t.is(report.socketsLeft, 0, 'nenhum socket aberto no fim')
  t.ok(report.description.includes('loopback'), 'diz que é medição em loopback')
  t.ok(report.description.includes('não é uma medida de capacidade'), 'não é alegação de capacidade')
  t.is(report.clients, 2)
  t.ok(report.opens >= 2, 'cada leitor abriu ao menos uma vez')
  t.alike(Object.keys(report.operations), OPERATIONS)
  for (const op of ['sync.start', 'feed.read', 'profile.read', 'peek.read', 'notices.list', 'index.counts']) {
    t.ok(report.operations[op].count >= 2, op + ' medido')
  }
  t.ok(report.operations['feed.read'].ok >= 2, 'feed.read respondeu')
  t.ok(report.peakExternal >= 1, 'pico de sockets externos amostrado')
  t.ok(report.bytesReceived.seeder > 0, 'bytes do semeador contados')
  t.ok(report.rssMiB.peak > 0)
  t.absent(/[0-9a-f]{64}|127\.0\.0\.1|wss?:\/\//.test(JSON.stringify(report)), 'sem chaves nem endereços')
  t.absent(JSON.stringify(report).includes(String.fromCharCode(0x2014)), 'sem travessão')
})
