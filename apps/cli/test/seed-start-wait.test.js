'use strict'

// VARANDA_START_WAIT: a second `seed` on the same data dir and ports waits in
// standby until the first frees its ports, then binds ws, health and only
// then opens the store. It never touches the first one's lock.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const b4a = require('b4a')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')

const baseEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) baseEnv[k] = v
// Turns the og transcoder on, so a photo-preview line shows how often it is built.
baseEnv.VARANDA_PUBLIC_ORIGIN = 'https://varanda.test'

function prepareSeederDir (t) {
  const kp = generateAssociationKeyPair()
  const assoc = b4a.toString(kp.publicKey, 'hex')
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, kp)))
  Seeder.addCert(dataDir, certFile, assoc)
  return dataDir
}

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function holdPort (t, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
    t.teardown(() => new Promise((resolve) => server.close(resolve)))
  })
}

function healthStatus (port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve(null))
  })
}

function run (t, args, extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, 'seed', '--json', ...args], { env: { ...baseEnv, ...extraEnv } })
  const proc = { child, stdout: '', stderr: '' }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', resolve))
  // Only whole lines: a trailing partial line would throw inside until().
  proc.events = () => proc.stdout.slice(0, proc.stdout.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  proc.names = () => proc.events().map((e) => e.event)
  proc.event = (name) => until(() => proc.events().find((e) => e.event === name), { name: 'evento ' + name, timeoutMs: 30000 })
  t.teardown(() => child.kill('SIGKILL'), { force: true })
  return proc
}

test('seed: VARANDA_START_WAIT waits in standby and takes over after the first process stops', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const dataDir = prepareSeederDir(t)
  const healthPort = await freePort()
  const wsPort = await freePort()
  const args = ['--data', dataDir, '--health-port', String(healthPort), '--ws-port', String(wsPort), ...bootstrapFlags(bootstrap)]
  const lockFile = path.join(dataDir, '.varanda-lock', 'pid')

  const a = run(t, args)
  await a.event('ready')
  const lockBytes = fs.readFileSync(lockFile)

  // Without the variable a busy port fails at once.
  const plain = run(t, args)
  t.is(await plain.exited, 1, 'without VARANDA_START_WAIT: exit 1')
  t.ok(plain.stderr.includes('porta em uso'), 'without VARANDA_START_WAIT: porta em uso')

  // A bad certificate fails before any wait.
  const certPath = path.join(dataDir, 'seeder-cert.json')
  const certBytes = fs.readFileSync(certPath)
  const cert = JSON.parse(certBytes)
  cert.signature = cert.signature.replace(/^./, (c) => c === '0' ? '1' : '0')
  fs.writeFileSync(certPath, JSON.stringify(cert))
  const badCert = run(t, args, { VARANDA_START_WAIT: '30' })
  const badCode = await badCert.exited
  fs.writeFileSync(certPath, certBytes)
  t.is(badCode, 1, 'tampered certificate: exit 1')
  t.ok(badCert.stderr.includes('certificado do semeador inválido'), 'tampered certificate: the start error')
  t.absent(badCert.names().includes('standby'), 'tampered certificate: no standby line')

  // A short wait gives up while the first process is alive.
  const short = run(t, args, { VARANDA_START_WAIT: '1' })
  t.is(await short.exited, 1, 'VARANDA_START_WAIT=1 with the first alive: exit 1')
  t.ok(short.stderr.includes('porta em uso'), 'VARANDA_START_WAIT=1: porta em uso')

  // SIGTERM in standby: exit 0 without starting.
  const quitter = run(t, args, { VARANDA_START_WAIT: '30' })
  await quitter.event('standby')
  quitter.child.kill('SIGTERM')
  t.is(await quitter.exited, 0, 'SIGTERM in standby: exit 0')
  t.absent(quitter.names().includes('ready'), 'SIGTERM in standby: never ready')
  t.is(await healthStatus(healthPort), 200, 'the first process keeps serving')

  const b = run(t, args, { VARANDA_START_WAIT: '30' })
  const standby = await b.event('standby')
  t.ok(Number.isSafeInteger(standby.at), 'standby carries at')
  t.is(await healthStatus(healthPort), 200, 'the first process still answers /health')
  const waiting = b.names()
  for (const name of ['ws', 'health', 'ready']) t.absent(waiting.includes(name), 'standby: no ' + name + ' line yet')
  t.alike(fs.readFileSync(lockFile), lockBytes, 'standby leaves the lock alone')
  t.is(a.child.exitCode, null, 'the first process is still running')

  a.child.kill('SIGTERM')
  t.is(await a.exited, 0, 'first process exits 0')
  await b.event('ready')
  const order = b.names().filter((n) => ['ws', 'health', 'ready'].includes(n))
  t.alike(order, ['ws', 'health', 'ready'], 'ws, health, ready in that order')
  t.is(b.names().filter((n) => n === 'standby').length, 1, 'exactly one standby line')
  t.ok(b.names().filter((n) => n === 'photo-preview').length <= 1, 'at most one photo-preview line')
  t.is(await healthStatus(healthPort), 200, 'the second process answers /health')

  b.child.kill('SIGTERM')
  t.is(await b.exited, 0, 'second process exits 0')
})

test('seed: VARANDA_START_WAIT with only the health port busy binds ws, waits, and never opens the store', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const dataDir = prepareSeederDir(t)
  const healthPort = await freePort()
  const wsPort = await freePort()
  await holdPort(t, healthPort)
  const args = ['--data', dataDir, '--health-port', String(healthPort), '--ws-port', String(wsPort), ...bootstrapFlags(bootstrap)]
  const lockDir = path.join(dataDir, '.varanda-lock')
  const storeDir = path.join(dataDir, 'store')

  const short = run(t, args, { VARANDA_START_WAIT: '1' })
  await short.event('standby')
  t.alike(short.names().filter((n) => ['ws', 'standby'].includes(n)), ['ws', 'standby'], 'ws, then standby')
  t.is(await short.exited, 1, 'VARANDA_START_WAIT=1: exit 1')
  t.ok(short.stderr.includes('porta em uso'), 'VARANDA_START_WAIT=1: porta em uso')
  t.absent(short.names().includes('ready'), 'VARANDA_START_WAIT=1: never ready')
  t.absent(fs.existsSync(lockDir), 'VARANDA_START_WAIT=1: no lock')
  t.absent(fs.existsSync(storeDir), 'VARANDA_START_WAIT=1: no store')

  const quitter = run(t, args, { VARANDA_START_WAIT: '30' })
  await quitter.event('standby')
  t.alike(quitter.names().filter((n) => ['ws', 'standby'].includes(n)), ['ws', 'standby'], 'ws, then standby')
  quitter.child.kill('SIGTERM')
  t.is(await quitter.exited, 0, 'SIGTERM in standby: exit 0')
  t.absent(quitter.names().includes('ready'), 'SIGTERM in standby: never ready')
  t.absent(fs.existsSync(lockDir), 'SIGTERM in standby: no lock')
  t.absent(fs.existsSync(storeDir), 'SIGTERM in standby: no store')
})
