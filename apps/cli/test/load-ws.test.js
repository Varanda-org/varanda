const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { startSeedWs } = require('../lib/seed-ws')
const { startHealth } = require('../lib/health')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'load-ws.js')

function run (t, args) {
  const child = spawn(process.execPath, [SCRIPT, ...args])
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
  t.teardown(async () => {
    child.kill('SIGKILL')
    await exited
  }, { force: true })
  return exited
}

function report (t, result) {
  t.is(result.code, 0, 'medição concluída')
  t.is(result.stderr, '', 'sem diagnósticos sensíveis')
  t.is(result.stdout.trim().split('\n').length, 1, 'um único objeto JSON')
  t.absent(/127\.0\.0\.1|localhost|wss?:\/\/|[0-9a-f]{64}/i.test(result.stdout + result.stderr), 'sem endereços ou chaves')
  const data = JSON.parse(result.stdout)
  t.ok(data.description.includes('conexões admitidas ociosas, não tráfego real'), 'escopo explícito')
  return data
}

test('load-ws: admissão real, limites, saúde e argumentos somente locais', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const association = generateAssociationKeyPair()
  const associationKey = association.publicKey.toString('hex')
  const dataDir = tmpDir(t, 'varanda-load-')
  Seeder.ensureConfig(dataDir, associationKey)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-load-cert-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, association)))
  Seeder.addCert(dataDir, certFile, associationKey)
  const seeder = new Seeder({ dataDir, associationKey, maxExternal: 2, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })

  const args = ['--port', String(ws.port), '--clients', '4', '--hold-ms', '500', '--json']
  const data = report(t, await run(t, args))
  t.is(data.attempted, 4)
  t.is(data.opened, 2, 'apenas duas conexões recebem o hello após Noise')
  t.is(data.refused, 2, 'upgrade WebSocket não conta como admissão')
  t.ok(data.handshakeMs.p50 >= 0)
  t.ok(data.handshakeMs.p95 >= data.handshakeMs.p50)
  t.ok(data.handshakeMs.max >= data.handshakeMs.p95)
  await until(() => seeder.stats().external === 0, { name: 'conexões encerradas' })

  let connections = 0
  const probe = net.createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => probe.close(resolve)), { force: true })
  const probePort = String(probe.address().port)
  const invalidArgs = [
    ['--host', 'endereco-proibido'],
    ['--url', 'ws://endereco-proibido/seeder'],
    ['--host=endereco-proibido'],
    ['--url=ws://endereco-proibido/seeder'],
    ['--clients', '4097'],
    ['--hold-ms', '25001'],
    ['--port', '0'],
    ['--health-port', '65536']
  ]
  for (const extra of invalidArgs) {
    const result = await run(t, ['--port', probePort, '--health-port', probePort, '--json', ...extra])
    t.is(result.code, 2, 'argumentos inválidos: ' + extra[0])
    t.is(result.stdout, '', 'nenhum JSON em erro de uso')
    t.ok(result.stderr.startsWith('uso: '), 'uso em português')
    t.absent(result.stderr.includes('endereco-proibido'), 'argumentos não são reproduzidos')
  }
  t.is(connections, 0, 'nenhum socket aberto com argumentos inválidos')

  const health = await startHealth({ port: 0, stats: () => seeder.stats() })
  t.teardown(() => health.close(), { force: true })
  const sampled = report(t, await run(t, [
    '--port', String(ws.port), '--clients', '2', '--hold-ms', '1200',
    '--health-port', String(health.port), '--json'
  ]))
  t.is(sampled.opened, 2)
  t.is(sampled.refused, 0)
  t.ok(sampled.health.samples >= 2, 'saúde amostrada novamente após um segundo')
  t.is(sampled.health.errors, 0)
  t.is(sampled.health.connections, 2, 'máximo de conexões')
  t.is(sampled.health.external, 2, 'máximo de conexões externas')
  await until(() => seeder.stats().external === 0, { name: 'conexões monitoradas encerradas' })

  const refused = report(t, await run(t, ['--port', probePort, '--clients', '1', '--hold-ms', '0', '--json']))
  t.is(refused.attempted, 1)
  t.is(refused.opened, 0)
  t.is(refused.refused, 1)
  t.alike(refused.handshakeMs, { p50: null, p95: null, max: null }, 'sem latências inventadas quando ninguém é admitido')
})
