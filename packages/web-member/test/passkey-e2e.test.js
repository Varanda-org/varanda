// End to end, loopback only: the passkey identity on two "devices" (two
// browser node sessions over two memory storages, the SAME key pair handed
// to both as the page derives it from the passkey) through a CLI seeder
// (`seed --ws-port`). What is proven here and nowhere else:
// - the write gate: every diary write first catches up with the seeder in an
//   internal once run, is refused when the seeder cannot be reached, and is
//   followed by a push run the seeder confirms (seederConfirmed);
// - a fresh device recovers its own diary (certificate included) from the
//   seeder before it may write, and both devices' writes interleave;
// - a live continuous run tracking the own diary stands in for the gate.
// Kept apart from session-e2e.test.js so each file stays under the runner's
// per-file limit (scripts/run-tests.js).
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, loadAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')

const BIN = path.join(__dirname, '../../../apps/cli/bin/varanda.js')
const GATE_LINE = 'sincronizando antes de publicar'
const PUSH_LINE = 'enviando ao semeador'
const NOT_SYNCED = 'sincronize com o semeador antes de publicar'
const CORE_FILES = ['oplog', 'tree', 'bitfield', 'data', 'header']

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function jsonLines (stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((v) => v !== null)
}

// The CLI as a child process, with the loopback testnet flags; killed in teardown.
function varanda (t, bootstrap, args) {
  const child = spawn(process.execPath, [BIN, ...args, ...bootstrapFlags(bootstrap)], { env })
  const proc = { stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(proc) }))
  proc.kill = () => child.kill('SIGTERM')
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await proc.exited
    }
  }, { force: true })
  return proc
}

async function run (t, bootstrap, args) {
  const proc = await varanda(t, bootstrap, args).exited
  t.is(proc.code, 0, args.slice(0, 2).join(' ') + ' ' + proc.stderr)
  const lines = jsonLines(proc.stdout)
  return lines[lines.length - 1]
}

// A loopback port with nothing listening (bound, then released).
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function call (file, method, ...args) {
  return new Promise((resolve, reject) => {
    file[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}

// True when some file of the 'diary' core holds `needle`.
async function diaryHolds (storage, needle) {
  let found = false
  for (const name of CORE_FILES) {
    const file = storage.core('diary')(name)
    const { size } = await call(file, 'stat')
    if (size > 0 && b4a.indexOf(await call(file, 'read', 0, size), needle) !== -1) found = true
    await call(file, 'close')
  }
  return found
}

// A device: a node over `storage` with the gate on, unlocked with keyPair.
async function device (t, { storage, association, seederUrl, keyPair, writeGateTimeoutMs = 15000 }) {
  const internal = []
  const node = createBrowserNode({
    storage,
    association,
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300 },
    writeGateTimeoutMs
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  return { node, web, storage, internal }
}

// The runs started since event index `from`: [{ runId, lines, stopped }].
async function runsSince (web, from) {
  const out = []
  for (const e of web.events.slice(from)) {
    if (e.name !== 'sync.started') continue
    const { runId } = e.data
    const lines = web.events.filter((x) => x.name === 'sync.event' && x.data.runId === runId).map((x) => x.data.line)
    out.push({ runId, once: e.data.once, lines, stopped: await stoppedOf(web.events, runId) })
  }
  return out
}

// A gated write: exactly a gate run (own-synced) and a push run (confirmed).
async function gatedWrite (t, web, method, params, label) {
  const from = web.events.length
  const result = await web.request(method, params)
  const runs = await runsSince(web, from)
  t.is(runs.length, 2, label + ': a gate run and a push run')
  const [gate, push] = runs
  t.is(gate.lines[0], GATE_LINE, label + ': the gate run names itself')
  t.ok(gate.lines.some((l) => /^diário próprio sincronizado \(\d+\)$/.test(l)), label + ': own-synced in the gate run')
  t.is(push.lines[0], PUSH_LINE, label + ': the push run names itself')
  if (push.stopped.reason !== 'done') t.comment(JSON.stringify(push))
  t.is(push.stopped.reason, 'done', label + ': push done')
  t.is(push.stopped.result.seederConfirmed, true, label + ': the seeder holds the whole diary')
  return { result, gate, push }
}

test('two devices with the same passkey: gate, push, recovery and a stale device', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)

  // The association, created by the CLI; its key pair signs every cert.
  const assocDir = tmpDir(t, 'varanda-pk-assoc-')
  const association = (await run(t, bootstrap, ['assoc', 'init', '--data', assocDir, '--json'])).publicKey
  const assocKp = loadAssociationKeyPair(path.join(assocDir, 'association.json'))

  // The seeder: the CLI binary with its WebSocket entry on a system port.
  const seederDir = tmpDir(t, 'varanda-pk-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const seederCertFile = path.join(tmpDir(t, 'varanda-pk-sc-'), 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
  Seeder.addCert(seederDir, seederCertFile, association)
  const seed = varanda(t, bootstrap, ['seed', '--data', seederDir, '--ws-port', '0', '--json'])
  const wsEvent = await until(() => jsonLines(seed.stdout).find((e) => e.event === 'ws'), { name: 'ws do semeador', timeoutMs: 30000 })
  await until(() => jsonLines(seed.stdout).some((e) => e.event === 'ready'), { name: 'semeador pronto', timeoutMs: 30000 })
  const seederUrl = 'ws://127.0.0.1:' + wsEvent.port + '/seeder'

  // The passkey-derived pair, the same on both devices; the storages outlive
  // the nodes (as IndexedDB does).
  const keyPair = crypto.keyPair()
  const keyHex = b4a.toString(keyPair.publicKey, 'hex')
  const storageA = memoryNodeStorage()
  storageA.close = async () => {}
  const storageB = memoryNodeStorage()
  storageB.close = async () => {}

  // ---- device A: identity, certificate, profile, a post; each write gated and pushed ----
  let a = await device(t, { storage: storageA, association, seederUrl, keyPair })
  t.alike(await a.web.request('identity.create'), { publicKey: keyHex, association })
  t.absent(a.web.events.some((e) => e.name === 'sync.started'), 'creating the identity starts no run')
  const cert = createCert({ member: keyHex }, assocKp)
  const certWrite = await gatedWrite(t, a.web, 'cert.add', { cert }, 'A cert.add')
  t.alike(certWrite.result, { seq: 0 })
  t.ok(certWrite.gate.lines.includes('diário próprio sincronizado (0)'), 'a new diary: the seeder holds nothing for the key')
  t.is(certWrite.push.stopped.result.admitted, true, 'admitted on the push')
  t.alike(await gatedWrite(t, a.web, 'profile.set', { name: 'Ana', bio: '' }, 'A profile.set').then((r) => r.result), { seq: 1, ref: keyHex + ':1' })
  const postA = await gatedWrite(t, a.web, 'post.create', { text: 'de A' }, 'A post.create')
  t.alike(postA.result, { seq: 2, ref: keyHex + ':2' })
  t.ok(postA.gate.lines.includes('diário próprio sincronizado (2)'), 'the gate saw the seeder hold what A holds')
  t.alike(await a.web.request('sync.status'), { state: 'idle' }, 'no run left behind')
  t.absent(await diaryHolds(storageA, keyPair.secretKey), 'the storage never holds the secret')
  t.ok(await diaryHolds(storageA, keyPair.publicKey))

  // ---- device B: the same pair on an empty storage recovers the diary ----
  const b = await device(t, { storage: storageB, association, seederUrl, keyPair })
  t.alike(await b.web.request('identity.create'), { publicKey: keyHex, association }, 'the same key on the second device')
  t.alike(await b.node.identityStatus(), { exists: true, publicKey: keyHex, legacy: false, unlocked: true, synced: false })
  t.is((await b.web.request('node.info')).memberCert, false, 'nothing yet')
  t.alike((await b.web.request('log.read', {})).entries, [])
  const { runId: recovery } = await b.web.request('sync.start', { once: true, timeoutMs: 30000 })
  const recovered = await stoppedOf(b.web.events, recovery)
  if (recovered.reason !== 'done') t.comment(JSON.stringify(b.web.events))
  t.is(recovered.reason, 'done', 'B\'s run done')
  t.is(recovered.result.ok, true)
  t.is(recovered.result.admitted, true, 'B announced the recovered certificate and was admitted')
  t.is(recovered.result.seederConfirmed, true)
  const recoveryLines = b.web.events.filter((e) => e.name === 'sync.event' && e.data.runId === recovery).map((e) => e.data.line)
  t.ok(recoveryLines.includes('diário próprio atrasado (0/3)'), 'B saw itself behind')
  t.ok(recoveryLines.includes('certificado recuperado do semeador'), 'the certificate was recomputed from block 0')
  t.ok(recoveryLines.includes('diário próprio sincronizado (3)'), 'and B caught up')
  const logB = await b.web.request('log.read', {})
  t.alike(logB.entries.map((e) => e.seq), [0, 1, 2])
  t.is(logB.entries[0].record.type, 'member-cert')
  t.is(logB.entries[1].record.name, 'Ana')
  t.is(logB.entries[2].record.text, 'de A')
  t.alike(logB.invalid, [])
  t.is((await b.web.request('node.info')).memberCert, true, 'the certificate is in B\'s diary')
  t.is((await b.node.identityStatus()).synced, true)
  t.absent(await diaryHolds(storageB, keyPair.secretKey), 'B\'s storage never holds the secret either')

  // B writes after A: gated (already caught up) and pushed.
  const postB = await gatedWrite(t, b.web, 'post.create', { text: 'de B' }, 'B post.create')
  t.alike(postB.result, { seq: 3, ref: keyHex + ':3' })
  t.ok(postB.gate.lines.includes('diário próprio sincronizado (3)'))

  // ---- device A, stale: offline it cannot write; online it catches up first ----
  await a.node.close()
  const offline = await device(t, { storage: storageA, association, seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder', keyPair, writeGateTimeoutMs: 2000 })
  const refused = await errorOf(offline.web.request('post.create', { text: 'sem semeador' }))
  t.is(refused && refused.code, 'USAGE')
  t.is(refused && refused.message, NOT_SYNCED, 'a device that cannot reach the seeder does not write')
  const offlineRuns = await runsSince(offline.web, 0)
  t.is(offlineRuns.length, 1, 'only the gate run')
  t.is(offlineRuns[0].lines[0], GATE_LINE)
  t.is(offlineRuns[0].stopped.reason, 'timeout')
  t.is((await offline.web.request('log.read', {})).entries.length, 3, 'nothing was appended')
  await offline.node.close()

  a = await device(t, { storage: storageA, association, seederUrl, keyPair })
  const postA2 = await gatedWrite(t, a.web, 'post.create', { text: 'de A depois' }, 'A post.create (stale)')
  t.ok(postA2.gate.lines.includes('diário próprio atrasado (3/4)'), 'A saw itself behind B\'s post')
  t.ok(postA2.gate.lines.includes('diário próprio sincronizado (4)'), 'and caught up before writing')
  t.alike(postA2.result, { seq: 4, ref: keyHex + ':4' }, 'the post went after B\'s')
  const logA = await a.web.request('log.read', {})
  t.alike(logA.entries.map((e) => [e.seq, e.record.text || e.record.type]), [[0, 'member-cert'], [1, 'profile'], [2, 'de A'], [3, 'de B'], [4, 'de A depois']])
  t.alike(logA.invalid, [])

  // ---- device B, a continuous run tracking the own diary stands in for the gate ----
  const ownSyncedOn = (runId, length) => b.web.events.some((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line === 'diário próprio sincronizado (' + length + ')')
  const { runId: first } = await b.web.request('sync.start', {})
  await until(() => ownSyncedOn(first, 5), { name: 'B em dia na execução contínua', timeoutMs: 30000 })
  // The read is served on the run's own cores (no preemption): the gate
  // stands down because this run confirmed own-sync.
  t.is((await b.web.request('log.read', {})).entries.length, 5, 'B received A\'s later post on the continuous run')
  const status = await b.web.request('sync.status')
  t.is(status.state, 'running')
  t.is(status.once, false)
  const continuous = status.runId
  t.is(continuous, first, 'the read did not restart the continuous run')
  const from = b.web.events.length
  t.alike(await b.web.request('post.create', { text: 'contínuo' }), { seq: 5, ref: keyHex + ':5' })
  const after = b.web.events.slice(from)
  t.absent(after.some((e) => e.name === 'sync.event' && (e.data.line === GATE_LINE || e.data.line === PUSH_LINE)), 'no gate or push run while a continuous run tracks the diary')
  t.ok(after.some((e) => e.name === 'sync.stopped' && e.data.runId === continuous && e.data.reason === 'preempted'), 'the write preempted the continuous run')
  const restarted = after.find((e) => e.name === 'sync.started')
  t.ok(restarted && restarted.data.once === false, 'which restarted')
  await until(() => b.web.events.some((e) => e.name === 'sync.event' && e.data.runId === restarted.data.runId && e.data.line === 'have ' + keyHex + ' 6'), { name: 'semeador com o post contínuo', timeoutMs: 30000 })
  t.alike(await b.web.request('sync.stop'), { stopped: true })

  // A, idle, sees it on its next write's gate.
  const postA3 = await gatedWrite(t, a.web, 'post.create', { text: 'fim' }, 'A post.create (after the continuous write)')
  t.ok(postA3.gate.lines.includes('diário próprio atrasado (5/6)'))
  t.alike(postA3.result, { seq: 6, ref: keyHex + ':6' })

  // Nothing the sessions sent names the seeder's address, and nothing went
  // to the internal-error report.
  for (const [name, d] of [['A', a], ['B', b], ['offline', offline]]) {
    const sent = JSON.stringify(d.web.events)
    t.absent(sent.includes('127.0.0.1') || sent.includes('ws://'), name + ': no address in events')
    t.is(d.internal.length, 0, name + ': no internal error')
  }
  const seederLog = jsonLines(seed.stdout)
  t.ok(seederLog.some((e) => e.event === 'admitted' && e.key === keyHex), 'the seeder admitted the diary')
  seed.kill()
  await seed.exited
})
