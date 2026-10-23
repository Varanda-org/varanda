// G1 end to end, loopback only: a Hypercore 10 member (memory storage, the
// browser-side node) posts through the Hypercore 11 seeder over a WebSocket
// and goes away; then the CLI binary (Hypercore 11), certified by the same
// association, follows that member and reads the post from the seeder alone.
// A second Hypercore 10 member certified by another association is refused
// by the seeder with 'untrusted-association'.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const b4a = require('b4a')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair, loadAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { DIARY_OPTIONS } = require('../lib/diary-options')

const BIN = path.join(__dirname, '../../../apps/cli/bin/varanda.js')
const POST_TEXT = 'poste do navegador (spike)'

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v
delete env.VARANDA_BOOTSTRAP
delete env.VARANDA_DHT_HOST

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function jsonLines (stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((v) => v !== null)
}

// The CLI as a child process (never spawnSync: the seeder runs in this
// process and must keep serving while the child syncs). Every child gets the
// loopback testnet flags and is killed in teardown.
function varanda (t, bootstrap, args) {
  const child = spawn(process.execPath, [BIN, ...args, ...bootstrapFlags(bootstrap)], { env })
  const proc = { stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(proc) }))
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await exited
    }
  }, { force: true })
  return exited
}

function last (proc) {
  const lines = jsonLines(proc.stdout)
  return lines[lines.length - 1]
}

// Seeder data dir prepared like apps/cli/test/e2e.test.js:48-57.
function prepareSeederDir (t, assocKp) {
  const dataDir = tmpDir(t, 'varanda-g1-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-g1-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  return { dataDir, publicKey }
}

test('G1: a Hypercore 10 member posts through the seeder over WebSocket and the CLI member reads it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)

  // The association, created by the CLI; its key pair signs every cert.
  const assocDir = tmpDir(t, 'varanda-g1-assoc-')
  const init = await varanda(t, bootstrap, ['assoc', 'init', '--data', assocDir, '--json'])
  t.is(init.code, 0, 'assoc init ' + init.stderr)
  const association = last(init).publicKey
  const assocKp = loadAssociationKeyPair(path.join(assocDir, 'association.json'))
  t.is(hex(assocKp.publicKey), association)

  // Seeder: in-process, with a WebSocket entry handing streams to acceptStream.
  const { dataDir: seederDir, publicKey } = prepareSeederDir(t, assocKp)
  const events = []
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  let seederClosed = false
  t.teardown(() => { if (!seederClosed) return seeder.close() }, { force: true })
  await seeder.start()

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  let wssClosed = false
  const closeWss = () => {
    if (wssClosed) return
    wssClosed = true
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }
  t.teardown(closeWss, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  const port = wss.address().port

  // Writer: Hypercore 10, memory storage, fresh key pair.
  const m = await createMember({ storage: memoryStorage(), association, ...DIARY_OPTIONS })
  let memberClosed = false
  t.teardown(() => { if (!memberClosed) return m.close() }, { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))
  t.is(m.core.length, 1)
  t.comment('DIARY_OPTIONS ' + JSON.stringify(DIARY_OPTIONS) + '; key === publicKey: ' + (m.key === m.publicKey) +
    '; manifest version ' + (m.manifest ? m.manifest.version : null))

  const started = Date.now()
  const link = connectSeeder({
    member: m,
    socket: new WebSocket('ws://127.0.0.1:' + port + '/seeder'),
    association,
    seederPublicKey: publicKey,
    timeoutMs: 30000
  })
  t.teardown(() => link.close(), { force: true })
  const admitted = await link.admitted
  const admittedMs = Date.now() - started
  t.is(admitted.type, 'admitted')
  t.is(admitted.key, m.key)
  await m.post(POST_TEXT)
  t.is(m.core.length, 2)
  const served = await link.waitServed(2)
  t.ok(served >= 2, 'seeder reports length >= 2')
  await until(() => events.some((e) => e.event === 'have' && e.key === m.key && e.length === 2), { name: 'have 2 no log do semeador', timeoutMs: 30000 })
  const haveMs = Date.now() - started
  t.comment('ms da conexão até admitted: ' + admittedMs + '; até have 2: ' + haveMs)

  t.ok(link.verified, 'seeder hello verified')
  t.is(hex(link.noise.remotePublicKey), publicKey, 'Noise remote key is the seeder key')
  t.not(hex(link.noise.publicKey), m.key, 'the member Noise key is not the diary key')

  // The browser-side node is gone from here on.
  link.close()
  await m.close()
  memberClosed = true
  await closeWss()
  await until(() => seeder.stats().connections === 0, { name: 'conexão externa encerrada' })

  // Follower: the CLI binary, certified by the same association.
  const memberDir = tmpDir(t, 'varanda-g1-member-')
  const created = await varanda(t, bootstrap, ['id', 'create', '--data', memberDir, '--association', association, '--json'])
  t.is(created.code, 0, 'id create ' + created.stderr)
  const followerKey = last(created).publicKey
  const certFile = path.join(tmpDir(t, 'varanda-g1-mc-'), 'member-cert.json')
  const certified = await varanda(t, bootstrap, ['assoc', 'certify', '--data', assocDir, '--member', followerKey, '--age-band', '18+', '--method', 'stub', '--out', certFile, '--json'])
  t.is(certified.code, 0, 'assoc certify ' + certified.stderr)
  const added = await varanda(t, bootstrap, ['cert', 'add', '--data', memberDir, '--cert-file', certFile, '--json'])
  t.is(added.code, 0, 'cert add ' + added.stderr)
  const followed = await varanda(t, bootstrap, ['follow', '--data', memberDir, '--author', m.key, '--json'])
  t.is(followed.code, 0, 'follow ' + followed.stderr)

  const synced = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json'])
  const syncLines = jsonLines(synced.stdout)
  const result = syncLines[syncLines.length - 1]
  if (synced.code !== 0 || !result || !result.downloaded || result.downloaded[m.key] !== 2) {
    t.comment('sync stdout: ' + synced.stdout)
    t.comment('sync stderr: ' + synced.stderr)
    t.comment('seeder log: ' + JSON.stringify(events))
  }
  t.is(synced.code, 0, 'sync --once exits 0')
  t.ok(syncLines.some((e) => e.event === 'peer' && e.role === 'seeder' && e.verified === true), 'verified seeder peer')
  t.ok(syncLines.some((e) => e.event === 'downloaded' && e.key === m.key && e.length === 2), 'downloaded length 2')
  t.is(result && result.downloaded && result.downloaded[m.key], 2, 'result.downloaded is 2')

  const feed = await varanda(t, bootstrap, ['feed', '--data', memberDir, '--json'])
  t.is(feed.code, 0, 'feed ' + feed.stderr)
  const items = last(feed).items
  t.ok(items.some((i) => i.author === m.key && i.text === POST_TEXT), 'feed has the browser post')

  // Negative: another association's cert in block 0 of a Hypercore 10 core.
  const otherKp = generateAssociationKeyPair()
  const bad = await createMember({ storage: memoryStorage(), association, ...DIARY_OPTIONS })
  t.teardown(() => bad.close(), { force: true })
  const badCert = createCert({ member: bad.key }, otherKp)
  await t.exception(bad.setCert(badCert), /untrusted-association/, 'setCert refuses it locally')
  await bad.core.append(memberCertRecord(badCert))
  t.is(bad.core.length, 1)
  const wss2 = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss2.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss2.clients) client.terminate()
    return new Promise((resolve) => wss2.close(() => resolve()))
  }, { force: true })
  wss2.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  const badLink = connectSeeder({
    member: bad,
    socket: new WebSocket('ws://127.0.0.1:' + wss2.address().port + '/seeder'),
    association,
    seederPublicKey: publicKey,
    timeoutMs: 30000
  })
  t.teardown(() => badLink.close(), { force: true })
  const refused = await badLink.admitted.then(() => null, (err) => err)
  t.is(refused && refused.message, 'untrusted-association', 'seeder rejects with untrusted-association')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === bad.key && e.reason === 'untrusted-association'), 'rejection logged')
  t.absent(seeder.admittedKeys().includes(bad.key), 'not admitted')
  t.ok(seeder.admittedKeys().includes(m.key))
  badLink.close()

  // seed list takes the data-dir lock: only after close.
  await seeder.close()
  seederClosed = true
  const listed = await varanda(t, bootstrap, ['seed', 'list', '--data', seederDir, '--json'])
  t.is(listed.code, 0, 'seed list ' + listed.stderr)
  const admittedList = last(listed).admitted
  t.ok(admittedList.some((e) => e.key === m.key && e.length === 2), 'seed list shows the key with length 2')
  t.absent(admittedList.some((e) => e.key === bad.key), 'seed list excludes the rejected key')
  t.is(JSON.stringify(events).includes('127.0.0.1'), false, 'no address logged')
})
