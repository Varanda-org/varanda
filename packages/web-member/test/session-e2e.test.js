// End to end, loopback only: the browser node session (Hypercore 10, memory
// storage, the RPC client wired in memory as the app wires it) and a CLI
// member (the varanda binary, Hypercore 11) exchange posts and a reply
// through a CLI seeder (`seed --ws-port`) and nothing else: the web session
// reaches the seeder only over its WebSocket entry, the CLI member only over
// the local DHT.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, loadAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')

const BIN = path.join(__dirname, '../../../apps/cli/bin/varanda.js')
const WEB_TEXT = 'olá do navegador (sessão web)'
const CLI_TEXT = 'olá do terminal (membro CLI)'
const REPLY_TEXT = 'resposta do navegador'

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

function last (proc) {
  const lines = jsonLines(proc.stdout)
  return lines[lines.length - 1]
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
  return last(proc)
}

test('the web session and a CLI member exchange posts through the seeder', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)

  // The association, created by the CLI; its key pair signs every cert.
  const assocDir = tmpDir(t, 'varanda-wse-assoc-')
  const association = (await run(t, bootstrap, ['assoc', 'init', '--data', assocDir, '--json'])).publicKey
  const assocKp = loadAssociationKeyPair(path.join(assocDir, 'association.json'))

  // The seeder: the CLI binary with its WebSocket entry on a system port.
  const seederDir = tmpDir(t, 'varanda-wse-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const seederCertFile = path.join(tmpDir(t, 'varanda-wse-sc-'), 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
  Seeder.addCert(seederDir, seederCertFile, association)
  const seed = varanda(t, bootstrap, ['seed', '--data', seederDir, '--ws-port', '0', '--json'])
  const wsEvent = await until(() => jsonLines(seed.stdout).find((e) => e.event === 'ws'), { name: 'ws do semeador', timeoutMs: 30000 })
  await until(() => jsonLines(seed.stdout).some((e) => e.event === 'ready'), { name: 'semeador pronto', timeoutMs: 30000 })
  const seederUrl = 'ws://127.0.0.1:' + wsEvent.port + '/seeder'

  // The web node, its client in memory, its identity key handed to it as the
  // page does after the passkey. The write gate is off: the explicit once
  // runs below are the point of this test (passkey-e2e.test.js covers it).
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association,
    seederUrl,
    createSocket: (url) => new WebSocket(url),
    onInternalError: (err) => internal.push(err),
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })

  const { publicKey: webKey } = await web.request('identity.create')
  t.alike(await web.request('cert.add', { cert: createCert({ member: webKey }, assocKp) }), { seq: 0 })
  t.is((await web.request('profile.set', { name: 'Bia', bio: 'no navegador' })).seq, 1)
  const webPost = await web.request('post.create', { text: WEB_TEXT })
  t.alike(webPost, { seq: 2, ref: webKey + ':2' })

  // First run: the seeder admits and holds the web diary.
  const first = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped1 = await stoppedOf(web.events, first.runId)
  if (stopped1.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped1.reason, 'done', 'first web run done')
  t.is(stopped1.result.ok, true)
  t.is(stopped1.result.admitted, true, 'admitted by the seeder')
  t.is(stopped1.result.seederConfirmed, true, 'the seeder holds the whole diary')
  t.is(stopped1.result.seeders, 1)
  const lines1 = web.events.filter((e) => e.name === 'sync.event' && e.data.runId === first.runId).map((e) => e.data.line)
  t.ok(lines1.includes('sync ready'), 'sync ready line')
  t.ok(lines1.some((l) => l === 'peer seeder ' + seederKey.slice(0, 8)), 'verified seeder line')
  t.ok(lines1.some((l) => l.startsWith('admitted ' + webKey)), 'admitted line')

  // The CLI member: identity, certificate, a post; follows the web key.
  const memberDir = tmpDir(t, 'varanda-wse-member-')
  const cliKey = (await run(t, bootstrap, ['id', 'create', '--data', memberDir, '--association', association, '--json'])).publicKey
  const certFile = path.join(tmpDir(t, 'varanda-wse-mc-'), 'member-cert.json')
  await run(t, bootstrap, ['assoc', 'certify', '--data', assocDir, '--member', cliKey, '--age-band', '18+', '--method', 'stub', '--out', certFile, '--json'])
  await run(t, bootstrap, ['cert', 'add', '--data', memberDir, '--cert-file', certFile, '--json'])
  await run(t, bootstrap, ['profile', 'set', '--data', memberDir, '--name', 'Caio', '--json'])
  const cliPost = await run(t, bootstrap, ['post', '--data', memberDir, '--text', CLI_TEXT, '--json'])
  await run(t, bootstrap, ['follow', '--data', memberDir, '--author', webKey, '--json'])
  const cliSync = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json']).exited
  const cliLines = jsonLines(cliSync.stdout)
  const cliResult = cliLines[cliLines.length - 1]
  if (cliSync.code !== 0) t.comment('cli sync: ' + cliSync.stdout + cliSync.stderr)
  t.is(cliSync.code, 0, 'CLI sync --once exits 0')
  t.is(cliResult.downloaded[webKey], 3, 'the CLI member downloaded the whole web diary')
  t.is(cliResult.admitted, true, 'the CLI diary is admitted too')
  const cliFeed = await run(t, bootstrap, ['feed', '--data', memberDir, '--json'])
  t.ok(cliFeed.items.some((i) => i.author === webKey && i.text === WEB_TEXT && i.name === 'Bia'), 'the CLI feed has the web post')

  // The web session follows the CLI member and reads it from the seeder.
  t.alike(await web.request('follow.add', { key: cliKey }), { changed: true, followCount: 1 })
  const second = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped2 = await stoppedOf(web.events, second.runId)
  if (stopped2.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped2.reason, 'done', 'second web run done')
  t.is(stopped2.result.ok, true)
  t.is(stopped2.result.downloaded[cliKey], 3, 'the web session downloaded the CLI diary')
  t.alike(stopped2.result.skipped, [])
  const feed = await web.request('feed.read', { limit: 30 })
  const cliItem = feed.items.find((i) => i.author === cliKey)
  t.ok(cliItem && cliItem.text === CLI_TEXT && cliItem.name === 'Caio', 'the web feed has the CLI post with its name')
  t.ok(feed.items.some((i) => i.author === webKey && i.text === WEB_TEXT), 'and its own post')
  const log = await web.request('log.read', { author: cliKey })
  t.is(log.key, cliKey)
  t.is(log.entries.length, 3)
  t.is(log.entries[0].record.type, 'member-cert')

  // A reply from the web, read by the CLI member.
  const reply = await web.request('post.reply', { to: cliPost.ref, text: REPLY_TEXT })
  t.is(reply.seq, 3)
  const third = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped3 = await stoppedOf(web.events, third.runId)
  t.is(stopped3.reason, 'done', 'third web run done')
  t.is(stopped3.result.seederConfirmed, true)
  const cliSync2 = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json']).exited
  t.is(cliSync2.code, 0, 'second CLI sync exits 0')
  const cliFeed2 = await run(t, bootstrap, ['feed', '--data', memberDir, '--json'])
  const replyItem = cliFeed2.items.find((i) => i.author === webKey && i.text === REPLY_TEXT)
  t.ok(replyItem, 'the CLI feed has the web reply')
  t.alike(replyItem && replyItem.replyTo, { author: cliKey, seq: cliPost.seq }, 'reply points at the CLI post')

  // Nothing the session sent names the seeder's address, and nothing went
  // to the internal-error report.
  const sent = JSON.stringify(web.events)
  t.absent(sent.includes('127.0.0.1') || sent.includes('ws://'), 'no address in events')
  t.is(internal.length, 0, 'no internal error')
  const seederLog = jsonLines(seed.stdout)
  t.ok(seederLog.some((e) => e.event === 'admitted' && e.key === webKey), 'the seeder admitted the web diary')
  seed.kill()
  await seed.exited
})
