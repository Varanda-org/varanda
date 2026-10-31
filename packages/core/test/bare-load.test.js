'use strict'

// Runs the core under the real Bare runtime (devDependency bare-runtime):
// test/bare/smoke.js is spawned with a temp dir, two planted FIFOs, an
// association made here and a Node member peer on a loopback testnet; it
// must print `BARE OK` and exit 0. The Node peer runs runSync (long mode,
// aborted when the Bare process exits) so the Bare member can download its
// diary.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const { tmpDir } = require('./helpers/tmp')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const { openStore, openDiary, appendRecord, writeConfig } = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord } = require('../lib/records')
const { runSync } = require('../lib/sync')

// The launcher inside bare-runtime, not node_modules/.bin/bare: the platform
// packages (bare-runtime-<os>-<arch>) declare the same `bare` bin, and npm 10
// (bundled with Node 20) then links neither, so .bin/bare does not exist.
const BARE = path.join(path.dirname(require.resolve('bare-runtime/package')), 'bin', 'bare')
const SMOKE = path.join(__dirname, 'bare', 'smoke.js')

async function testnet (t, size = 3) {
  const raw = await require('hyperdht/testnet')(size)
  t.teardown(() => raw.destroy(), { order: Infinity, force: true })
  return raw.bootstrap.map(({ host, port }) => {
    const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    return h + ':' + port
  })
}

// A Node member with block 0 (cert from assocDir), a profile and one post.
async function makePeer (dir, assocDir, assocHex) {
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = b4a.toString(diary.key, 'hex')
    writeConfig(dir, { v: 1, role: 'member', association: assocHex })
    await appendRecord(diary, memberCertRecord(issueCertificate(assocDir, { member: key })))
    await appendRecord(diary, profileRecord({ name: 'Par', bio: '' }))
    await appendRecord(diary, postRecord({ text: 'olá do Node' }))
    return { key, length: diary.length }
  } finally {
    await store.close()
  }
}

function mkfifo (t, file) {
  const r = spawnSync('mkfifo', [file])
  t.is(r.status, 0, 'mkfifo ' + file)
}

test('the core runs under Bare: smoke script prints BARE OK', async (t) => {
  t.timeout(170000)
  t.ok(fs.existsSync(BARE), 'bare runtime at ' + BARE)
  const tmp = tmpDir(t, 'varanda-bare-')
  const bootstrap = await testnet(t)

  const assocDir = path.join(tmp, 'assoc')
  const { publicKey: assocHex } = initAssociation(assocDir)
  const peerDir = path.join(tmp, 'peer')
  const peer = await makePeer(peerDir, assocDir, assocHex)

  fs.mkdirSync(path.join(tmp, 'assoc-local'), { mode: 0o700 })
  mkfifo(t, path.join(tmp, 'assoc-local', 'members.jsonl'))
  mkfifo(t, path.join(tmp, 'fifo-key'))

  const child = spawn(BARE, [SMOKE, tmp, assocDir, peer.key, bootstrap.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 150000)
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  t.teardown(() => { clearTimeout(killer); try { child.kill('SIGKILL') } catch {} }, { force: true })

  // The Node peer serves its diary until the Bare process exits.
  const ac = new AbortController()
  exit.then(() => ac.abort())
  const peerRun = runSync({
    dataDir: peerDir,
    bootstrap,
    host: '127.0.0.1',
    once: false,
    signal: ac.signal,
    log: (line) => t.comment('peer: ' + line)
  })

  const { code, signal } = await exit
  clearTimeout(killer)
  const peerResult = await peerRun
  for (const line of stdout.split('\n')) if (line) t.comment('bare: ' + line)
  for (const line of stderr.split('\n')) if (line) t.comment('bare stderr: ' + line)
  t.is(signal, null, 'not killed')
  t.is(code, 0, 'bare exit 0')
  t.ok(/^BARE OK$/m.test(stdout), 'prints BARE OK')
  t.ok(/^globals structuredClone=function/m.test(stdout), 'Bare has structuredClone')
  const sync = /^SYNC (.*)$/m.exec(stdout)
  t.ok(sync !== null, 'runSync result printed')
  if (sync) {
    const result = JSON.parse(sync[1])
    t.ok(result.peers >= 1, 'bare saw the Node peer')
    t.is(result.downloaded[peer.key], peer.length, 'bare downloaded the Node diary')
    t.ok(result.ok, 'bare runSync ok: ' + JSON.stringify(result.errors))
  }
  // The long-running peer resolves { ok: true } on abort; its `peers` field
  // counts the connections open at that moment (the Bare side already left).
  t.is(peerResult.ok, true, 'Node peer run ended cleanly')
})

// lib/group-crypto.js under Bare: sodium-universal resolves to the Bare
// build of sodium-native, and the seal/open round trips work there too.
test('group-crypto.js loads and round trips under Bare', async (t) => {
  t.timeout(60000)
  const tmp = tmpDir(t, 'varanda-bare-crypto-')
  const script = path.join(tmp, 'group-crypto.js')
  fs.writeFileSync(script, [
    'const g = require(' + JSON.stringify(path.join(__dirname, '..', 'lib', 'group-crypto.js')) + ')',
    'const seed = new Uint8Array(32).map((_, i) => i)',
    'const pair = g.boxKeyPairFromSeed(seed)',
    'const key = g.newEpochKey()',
    "const sealed = g.sealRecord({ type: 'group-post', text: 'olá' }, key)",
    'const record = g.openRecord(sealed, key)',
    'const opened = g.openFrom(g.sealTo(key, pair.publicKey), pair)',
    'const same = opened !== null && opened.every((b, i) => b === key[i])',
    "const pk = Array.from(pair.publicKey, (b) => b.toString(16).padStart(2, '0')).join('')",
    "console.log('CRYPTO ' + JSON.stringify({ text: record && record.text, same, wrong: g.openRecord(sealed, g.newEpochKey()), pk }))"
  ].join('\n') + '\n')
  const child = spawn(BARE, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.teardown(() => { try { child.kill('SIGKILL') } catch {} }, { force: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  t.is(code, 0, 'bare exit 0 ' + stderr.trim())
  const line = /^CRYPTO (.*)$/m.exec(stdout)
  t.ok(line !== null, 'result printed')
  if (line) {
    t.alike(JSON.parse(line[1]), {
      text: 'olá',
      same: true,
      wrong: null,
      pk: '4701d08488451f545a409fb58ae3e58581ca40ac3f7f114698cd71deac73ca01'
    }, 'round trips, rejects a wrong key, golden seed key pair')
  }
})
