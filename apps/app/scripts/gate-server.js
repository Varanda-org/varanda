'use strict'

// The worklet gate driver (docs/ios-gate.md), run on the host of the iOS
// simulator or the Android emulator:
//   node scripts/gate-server.js [--platform ios|android] [--host <ip>] [--port 8790] [--device booted] [--bundle-id app.varanda] [--no-launch]
// Starts a loopback hyperdht testnet, an association, a certified seeder and
// a CLI-equivalent member peer (the same core session the CLI and
// varanda-serve use) with one post, then serves the app's gate harness
// (src/gate/harness.js, built with EXPO_PUBLIC_VARANDA_GATE_URL) on
// 127.0.0.1:<port>:
//   GET  /config  -> { runId, association, bootstrap, peerKey, peerPost, phase }
//   POST /certify { publicKey } -> { cert }  (a member certificate)
//   POST /report  { step, ok, detail }
// and drives the device with xcrun simctl on iOS or adb on Android
// (terminate/launch for the kill step, another app then the varanda:// URL
// for background/resume). On Android it also runs adb reverse for the port,
// and puts the testnet and the seeder on --host (default: this machine's
// first non-loopback IPv4 address), because the emulator's 127.0.0.1 is the
// emulator itself while the simulator shares the Mac's loopback. Prints
// every step, then `GATE OK` when steps a-i all passed, else
// `GATE FAIL <step>: <detail>`; exit code 0 / 1.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')

const corePkg = path.dirname(require.resolve('@varanda/core/package.json'))

// lib/net.js createSwarm keeps hyperdht's firewall probing on for a DHT bound
// to a non-loopback host, so the seeder and the CLI peer would ask the app to
// hole-punch through the emulator's NAT, which fails (PEER_CONNECTION_FAILED).
// The gate's nodes are all directly reachable, so with --host on Android the
// driver turns probing off. It wraps hyperdht before the core is loaded.
let dhtFirewalled = true
const hyperdhtPath = require.resolve('hyperdht', { paths: [corePkg] })
const HyperDHT = require(hyperdhtPath)
class GateDHT extends HyperDHT {
  constructor (opts) {
    super(dhtFirewalled ? opts : { ...opts, firewalled: false })
  }
}
require.cache[hyperdhtPath].exports = GateDHT

const createTestnet = require(require.resolve('hyperdht/testnet', { paths: [corePkg] }))
const { initAssociation, issueCertificate, issueSeederCertificate } = require('@varanda/core/lib/assoc')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSession } = require('@varanda/core/lib/session')
const { createServerDispatcher, createClient, EVENTS } = require('@varanda/rpc')

const STEPS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
const STEP_NAMES = {
  a: 'structuredClone and the fs O_NOFOLLOW facade in the worklet',
  b: 'identity.create',
  c: 'cert.add with the driver-issued certificate',
  d: 'post.create',
  e: 'kill + relaunch: log.read shows the post (recover on the cold start)',
  f: 'sync once both ways with the CLI peer through the seeder',
  g: 'background/resume: node.info answers',
  h: 'second worklet without recover refused with LOCKED, stopped cleanly',
  i: 'terminateNode (node.close) then startNode without recover'
}
const APP_POST = 'post do app (gate)'
const PEER_POST = 'post do par CLI (gate)'
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000

function parseArgs (argv) {
  const opts = { platform: 'ios', host: null, port: 8790, device: 'booted', bundleId: null, launch: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--platform') opts.platform = argv[++i]
    else if (a === '--host') opts.host = argv[++i]
    else if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--device') opts.device = argv[++i]
    else if (a === '--bundle-id') opts.bundleId = argv[++i]
    else if (a === '--no-launch') opts.launch = false
    else throw new Error('unknown argument: ' + a)
  }
  if (opts.platform !== 'ios' && opts.platform !== 'android') throw new Error('invalid --platform')
  // The Android debug build has the .debug application ID suffix (android/app/build.gradle).
  if (opts.host === null) opts.host = opts.platform === 'android' ? lanAddress() : '127.0.0.1'
  if (opts.bundleId === null) opts.bundleId = opts.platform === 'android' ? 'app.varanda.debug' : 'app.varanda'
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error('invalid --port')
  return opts
}

function lanAddress () {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  throw new Error('no non-loopback IPv4 address; pass --host')
}

function log (line) {
  console.log('[gate ' + new Date().toISOString().slice(11, 19) + '] ' + line)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function run (cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function attempt (fn) {
  try {
    return fn()
  } catch (err) {
    return null
  }
}

// What the driver does to the app on the device. The data dir lives under
// Documents on iOS (read from the host through the simulator container) and
// under the app's files dir on Android (read through run-as, which a debug
// build allows).
function iosDevice ({ device, bundleId }) {
  const simctl = (...args) => run('xcrun', ['simctl', ...args])
  return {
    name: 'xcrun simctl',
    setup () {},
    teardown () {},
    launch: () => simctl('launch', device, bundleId),
    terminate: () => simctl('terminate', device, bundleId),
    background: () => simctl('launch', device, 'com.apple.Preferences'),
    foreground: () => simctl('openurl', device, 'varanda://'),
    lock (runId) {
      const dir = attempt(() => simctl('get_app_container', device, bundleId, 'data'))
      if (dir === null) return null
      const file = path.join(dir, 'Documents', 'varanda-gate-' + runId, '.varanda-lock')
      return { file, held: () => fs.existsSync(file) }
    }
  }
}

function androidDevice ({ device, bundleId, port }) {
  const adb = (...args) => run('adb', [...(device === 'booted' ? [] : ['-s', device]), ...args])
  return {
    name: 'adb',
    // The emulator's 127.0.0.1 is the emulator itself: reverse the port so the
    // app reaches the driver on the same URL as on iOS.
    setup: () => adb('reverse', 'tcp:' + port, 'tcp:' + port),
    teardown: () => attempt(() => adb('reverse', '--remove', 'tcp:' + port)),
    launch: () => adb('shell', 'monkey', '-p', bundleId, '-c', 'android.intent.category.LAUNCHER', '1'),
    terminate: () => adb('shell', 'am', 'force-stop', bundleId),
    background: () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'),
    foreground: () => adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'varanda://', bundleId),
    lock (runId) {
      const file = 'files/varanda-gate-' + runId + '/.varanda-lock'
      return { file, held: () => attempt(() => adb('shell', 'run-as', bundleId, 'test', '-e', file)) !== null }
    }
  }
}

// A session wired to an in-memory @varanda/rpc dispatcher + client pair, as
// in packages/core/test/helpers/net.js: the CLI-equivalent member peer.
async function memberPeer (dataDir, association, bootstrap) {
  const session = createSession({ dataDir, association, bootstrap })
  let client = null
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send: (message, text) => queueMicrotask(() => client.receive(JSON.parse(text)))
  })
  client = createClient({
    send: (message, text) => queueMicrotask(() => dispatcher.receive(JSON.parse(text))),
    timeoutMs: 120000
  })
  const events = []
  for (const name of EVENTS) client.on(name, (data) => events.push({ name, data }))
  session.attach(dispatcher.emit)
  await client.request('session.open')
  const call = (method, params) => client.request(method, params)
  async function syncOnce () {
    const { runId } = await call('sync.start', { once: true, timeoutMs: 60000 })
    for (let i = 0; i < 1200; i++) {
      const ev = events.find((e) => e.name === 'sync.stopped' && e.data.runId === runId)
      if (ev) return ev.data
      await sleep(100)
    }
    throw new Error('sync once did not stop')
  }
  async function close () {
    client.close()
    dispatcher.close()
    await session.close()
  }
  return { call, syncOnce, close }
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 65536) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-gate-'))
  const runId = Date.now().toString(36)
  const cleanups = []
  const device = (opts.platform === 'android' ? androidDevice : iosDevice)(opts)
  const results = new Map()
  let phase = 'fresh'
  let appKey = null
  let finished = false
  let cliCheck = null

  log('run ' + runId + ', work dir ' + root)

  dhtFirewalled = opts.platform !== 'android'
  const testnet = await createTestnet(3, { host: opts.host })
  cleanups.push(() => testnet.destroy())
  const bootstrap = testnet.bootstrap.map(({ host, port }) => {
    const h = host === '0.0.0.0' || host === '::' ? opts.host : host
    return h + ':' + port
  })
  log('testnet bootstrap ' + bootstrap.join(','))

  const assocDir = path.join(root, 'assoc')
  const { publicKey: association } = initAssociation(assocDir)
  log('association ' + association)

  const seedDir = path.join(root, 'seeder')
  Seeder.ensureConfig(seedDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seedDir)
  const seederCertFile = path.join(root, 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(issueSeederCertificate(assocDir, { seeder: seederKey })))
  Seeder.addCert(seedDir, seederCertFile, association)
  const seeder = new Seeder({ dataDir: seedDir, bootstrap, host: opts.host })
  await seeder.start()
  cleanups.push(() => seeder.close())
  log('certified seeder ' + seederKey.slice(0, 8) + ' started')

  const peer = await memberPeer(path.join(root, 'peer'), association, bootstrap)
  cleanups.push(() => peer.close())
  const { publicKey: peerKey } = await peer.call('identity.create')
  await peer.call('cert.add', { cert: issueCertificate(assocDir, { member: peerKey }) })
  await peer.call('post.create', { text: PEER_POST })
  const first = await peer.syncOnce()
  if (!first.result || first.result.ok !== true || first.result.seederConfirmed !== true) {
    throw new Error('CLI peer initial sync failed: ' + JSON.stringify(first.result))
  }
  log('CLI peer ' + peerKey.slice(0, 8) + ' posted "' + PEER_POST + '" and synced to the seeder')

  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  function record (step, ok, detail) {
    if (STEPS.includes(step) && !results.has(step)) results.set(step, { ok, detail })
    log((ok ? 'PASS ' : 'FAIL ') + step + (STEP_NAMES[step] ? ' (' + STEP_NAMES[step] + ')' : '') + ': ' + detail)
    if (!ok) resolveDone()
  }

  function launchApp () {
    attempt(() => device.terminate())
    device.launch()
  }

  // After the app's step f: the CLI peer follows the app, syncs once through
  // the seeder and must read the app's post.
  async function checkCli () {
    await peer.call('follow.add', { key: appKey })
    const r = await peer.syncOnce()
    const got = await peer.call('log.read', { author: appKey })
    const post = got.entries.find((e) => e.record.type === 'post' && e.record.text === APP_POST)
    if (!post) throw new Error('CLI peer did not get the app post (downloaded ' + JSON.stringify(r.result && r.result.downloaded) + ')')
    return 'CLI peer sync once ' + r.reason + ' downloaded ' + r.result.downloaded[appKey] + ' blocks of the app diary; log.read shows "' + APP_POST + '" at seq ' + post.seq
  }

  async function onReport (step, ok, detail) {
    if (step === 'f') {
      if (!ok) return record('f', false, detail)
      cliCheck = checkCli().then(
        (cli) => record('f', true, 'app: ' + detail + ' | ' + cli),
        (err) => record('f', false, 'app: ' + detail + ' | ' + err.message)
      )
      return
    }
    if (STEPS.includes(step)) return record(step, ok, detail)
    log('app: ' + step + ' ' + (ok ? 'ok' : 'failed') + ': ' + detail)
    if (!ok) return record(step, false, detail)
    if (step === 'ready:kill') {
      const lock = device.lock(runId)
      log('data-dir lock before the kill: ' + (lock !== null && lock.held() ? 'present' : 'absent') + (lock ? ' (' + lock.file + ')' : ''))
      phase = 'relaunched'
      device.terminate()
      log('app terminated (' + device.name + '); lock after the kill: ' + (lock !== null && lock.held() ? 'present' : 'absent'))
      await sleep(1500)
      device.launch()
      log('app relaunched')
    } else if (step === 'ready:background') {
      if (cliCheck !== null) await cliCheck
      if (results.has('f') && !results.get('f').ok) return
      await sleep(1000)
      device.background()
      log('app sent to the background')
      await sleep(5000)
      device.foreground()
      log('app brought back to the foreground (varanda:// URL)')
    } else if (step === 'done') {
      phase = 'done'
      resolveDone()
    }
  }

  const server = http.createServer((req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    ;(async () => {
      if (req.method === 'GET' && req.url === '/config') {
        log('app: GET /config (phase ' + phase + ')')
        return reply(200, { runId, association, bootstrap, peerKey, peerPost: PEER_POST, phase })
      }
      if (req.method === 'POST' && req.url === '/certify') {
        const body = await readBody(req)
        if (typeof body.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(body.publicKey)) return reply(400, { error: 'publicKey' })
        appKey = body.publicKey
        log('app: certify ' + appKey.slice(0, 8))
        return reply(200, { cert: issueCertificate(assocDir, { member: appKey }) })
      }
      if (req.method === 'POST' && req.url === '/report') {
        const body = await readBody(req)
        const step = String(body.step)
        reply(200, { ok: true })
        onReport(step, body.ok === true, String(body.detail)).catch((err) => record(step, false, 'driver: ' + err.message))
        return
      }
      reply(404, { error: 'not found' })
    })().catch((err) => {
      try { reply(500, { error: err.message }) } catch {}
    })
  })
  await new Promise((resolve) => server.listen(opts.port, '127.0.0.1', resolve))
  device.setup()
  cleanups.push(() => device.teardown())
  cleanups.push(() => new Promise((resolve) => server.close(resolve)))
  log('listening on http://127.0.0.1:' + opts.port + ' (build the app with EXPO_PUBLIC_VARANDA_GATE_URL=http://127.0.0.1:' + opts.port + ')')

  if (opts.launch) {
    launchApp()
    log('app launched (' + opts.bundleId + ' on ' + opts.device + ')')
  }

  const timer = setTimeout(() => {
    log('timeout after ' + TOTAL_TIMEOUT_MS / 1000 + ' s')
    resolveDone()
  }, TOTAL_TIMEOUT_MS)
  await done
  clearTimeout(timer)
  finished = true

  let failed = null
  for (const s of STEPS) {
    const r = results.get(s)
    if (!r) {
      failed = { step: s, detail: 'not reached' }
      break
    }
    if (!r.ok) {
      failed = { step: s, detail: r.detail }
      break
    }
  }
  if (failed === null && phase !== 'done') failed = { step: 'done', detail: 'harness did not finish' }

  for (const fn of cleanups.reverse()) {
    try { await fn() } catch {}
  }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}

  console.log('')
  for (const s of STEPS) {
    const r = results.get(s)
    console.log('  ' + s + ' ' + (r ? (r.ok ? 'PASS' : 'FAIL') : '----') + '  ' + STEP_NAMES[s])
  }
  if (failed === null) {
    console.log('GATE OK')
    process.exit(0)
  }
  console.log('GATE FAIL ' + failed.step + ': ' + failed.detail)
  process.exit(finished ? 1 : 2)
}

main().catch((err) => {
  console.log('GATE FAIL driver: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
