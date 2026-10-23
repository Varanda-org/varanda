// Spike (G3) evaluation, run by hand (not under test/, so the package's test
// run never picks it up):
//   cd packages/web-member && node ../../scripts/run-tests.js spike/relay-eval.test.js
// A Hypercore 10 member reaches the local DHT only through
// scripts/dht-relay.js over a WebSocket, joins the association rendezvous and
// is found and replicated DIRECTLY by a Hypercore 11 CLI member (runSync
// --once) with no seeder running. Prints exactly one line
//   RELAY_EVAL {"ok":...,"ms":...,"custody":...,"reason":...}
// and fails (nonzero exit) on NO-GO.
const test = require('brittle')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { WebSocket } = require('ws')
const b4a = require('b4a')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('../test/helpers/net')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { topicFor, attachAdmission } = require('@varanda/core/lib/admission')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { openStore, openDiary, appendRecord, writeConfig, writeFollows } = require('@varanda/core/lib/store')
const { runSync } = require('@varanda/core/lib/sync')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { createRelayedSwarm } = require('../lib/relay-link')

const RELAY = path.join(__dirname, '..', 'scripts', 'dht-relay.js')
const POST_TEXT = 'poste pelo relay (spike)'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function startRelay (t, bootstrap) {
  const child = spawn(process.execPath, [RELAY, '--port', '0', '--host', '127.0.0.1', ...bootstrapFlags(bootstrap)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const proc = { child, stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(code) }))
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGINT')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await proc.exited
      clearTimeout(timer)
    }
  }, { force: true })
  return proc
}

// The follower's data dir, prepared like apps/cli/test/e2e.test.js makeMember.
async function makeFollower (t, assocKp) {
  const dir = tmpDir(t, 'varanda-relay-follower-')
  writeConfig(dir, { v: 1, role: 'member', association: hex(assocKp.publicKey) })
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, assocKp)))
    return { dir, key }
  } finally {
    await store.close()
  }
}

// One full attempt; resolves { ok, ms, handshakeHash, reason }.
async function evaluate (t, { bootstrap, relayUrl, assocKp, custodial }, state) {
  const association = hex(assocKp.publicKey)
  state.step = 'bundle'
  const m = await createMember({ storage: memoryStorage(), association })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))
  await m.post(POST_TEXT)
  if (m.core.length !== 2) throw new Error('membro sem 2 blocos')

  state.step = 'handshake'
  const ws = new WebSocket(relayUrl)
  ws.on('error', () => {})
  // custodial is true only in the diagnostic retry below, which must say so.
  const swarm = createRelayedSwarm({ socket: ws, custodial, unsafeDiagnosticCustodial: custodial })
  t.teardown(() => swarm.destroy(), { force: true })
  const memberEvents = []
  const conns = []
  swarm.onConnection((conn) => {
    conns.push(conn)
    m.core.replicate(conn)
    try {
      attachAdmission(conn, {
        role: 'member',
        have: [{ key: m.key, length: m.core.length }],
        onmessage: (msg) => memberEvents.push(msg)
      })
    } catch (err) {
      memberEvents.push({ type: 'attach-error', error: err.message })
    }
  })
  let readyTimer
  try {
    await Promise.race([
      swarm.dht.ready(),
      new Promise((resolve, reject) => { readyTimer = setTimeout(() => reject(new Error('timeout')), 15000) })
    ])
  } finally {
    clearTimeout(readyTimer)
  }

  state.step = 'lookup'
  const joinedAt = Date.now()
  await swarm.join(topicFor(association))

  const follower = await makeFollower(t, assocKp)
  writeFollows(follower.dir, [m.key])
  const events = []
  let peerAt = null
  state.step = 'connect'
  const result = await runSync({
    dataDir: follower.dir,
    ...localSwarmOptions(bootstrap),
    once: true,
    timeoutMs: 30000,
    onEvent: (e) => {
      events.push(e)
      if (peerAt === null && e.event === 'peer' && e.role === 'member') peerAt = Date.now()
    }
  })
  const peerEvent = events.some((e) => e.event === 'peer' && e.role === 'member')
  const conn = conns[0] || null
  const handshakeHash = !!(conn && conn.handshakeHash && conn.handshakeHash.byteLength > 0)
  t.comment('follower result: ' + JSON.stringify({ ok: result.ok, peers: result.peers, downloaded: result.downloaded, skipped: result.skipped, errors: result.errors }))
  t.comment('follower events: ' + JSON.stringify(events.map((e) => e.event + (e.role ? ':' + e.role : '') + (e.reason ? ':' + e.reason : ''))))
  t.comment('member side: connections ' + conns.length + ', admission ' + JSON.stringify(memberEvents.map((e) => e.type + (e.role ? ':' + e.role : ''))))
  if (!peerEvent) {
    return { ok: false, ms: 0, handshakeHash, reason: 'timeout: ' + (conns.length > 0 ? 'gate' : 'connect') }
  }
  if (result.downloaded[m.key] !== 2) {
    return { ok: false, ms: peerAt - joinedAt, handshakeHash, reason: 'timeout: ' + (result.downloaded[m.key] === undefined ? 'gate' : 'download') + ' (' + JSON.stringify(result.downloaded) + ')' }
  }
  return { ok: true, ms: peerAt - joinedAt, handshakeHash, reason: '' }
}

async function attempt (t, ctx) {
  const state = { step: 'bundle' }
  try {
    return await evaluate(t, ctx, state)
  } catch (err) {
    return { ok: false, ms: 0, handshakeHash: false, reason: err.message + ' (' + state.step + ')' }
  }
}

test('G3: a relayed Hypercore 10 member is reached directly by a CLI member', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  // Setup guards: loopback DHT with a private bootstrap only.
  t.ok(bootstrap.length > 0 && bootstrap.every((b) => b.startsWith('127.0.0.1:')), 'private loopback bootstrap')

  let report = { ok: false, ms: 0, custody: 'noncustodial', reason: 'setup' }
  let relay = null
  try {
    relay = startRelay(t, bootstrap)
    const line = await until(() => relay.stdout.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).find((e) => e && e.event === 'relay'), { name: 'linha do relay', timeoutMs: 20000 })
    t.is(line.host, '127.0.0.1', 'relay bound to 127.0.0.1')
    t.ok(relay.stdout.startsWith('dht-relay experimental (não usar em produção) ws://127.0.0.1:' + line.port + '\n'))
    if (line.host !== '127.0.0.1') throw new Error('relay fora de 127.0.0.1')
    const relayUrl = 'ws://127.0.0.1:' + line.port

    const assocKp = generateAssociationKeyPair()
    const ctx = { bootstrap, relayUrl, assocKp }
    let out = await attempt(t, { ...ctx, custodial: false })
    if (!out.ok) {
      // One diagnostic retry with the package default (custodial), only to
      // fill the reason; ok stays false.
      const diag = await attempt(t, { ...ctx, custodial: true })
      out = { ...out, reason: out.reason + ' | padrão (custodial): ' + (diag.ok ? 'ok em ' + diag.ms + ' ms' : diag.reason) }
    }
    t.comment('handshakeHash on the relayed connection: ' + out.handshakeHash)
    report = { ok: out.ok, ms: out.ms, custody: 'noncustodial', reason: out.reason }
  } catch (err) {
    report = { ok: false, ms: 0, custody: 'noncustodial', reason: err.message + ' (setup)' }
  }
  t.comment(JSON.stringify(report))
  process.stdout.write('RELAY_EVAL ' + JSON.stringify(report) + '\n')
  if (relay) {
    const logged = (relay.stdout + relay.stderr).split('127.0.0.1').length - 1
    t.is(logged, 2, 'no address logged beyond the two listen lines')
  }
  t.ok(report.ok, 'G3: ' + (report.ok ? 'GO' : 'NO-GO: ' + report.reason))
})
