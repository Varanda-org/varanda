// `seed --json` logs the timings of one deploy: `ready` and `ws` carry an
// absolute `at`, and a SIGTERM ends with a `stopped` event holding drainMs,
// closeMs and stopListeningAt, so one production deploy gives the close time
// and (with the next process's `ws.at`) the time the port was dark.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const b4a = require('b4a')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

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

test('seed: ws and ready carry at; SIGTERM logs stopped with drainMs, closeMs, stopListeningAt', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const child = spawn(process.execPath, [BIN, 'seed', '--json', '--data', prepareSeederDir(t), '--ws-port', '0', ...bootstrapFlags(bootstrap)], { env })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', () => {})
  const exited = new Promise((resolve) => child.on('close', resolve))
  t.teardown(() => child.kill('SIGKILL'), { force: true })
  const events = () => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const event = (name) => until(() => events().find((e) => e.event === name), { name: 'evento ' + name, timeoutMs: 30000 })

  const ws = await event('ws')
  const ready = await event('ready')
  const before = Date.now()
  t.ok(Number.isSafeInteger(ws.at) && ws.at <= before && ws.at > before - 120000, 'ws.at is a plausible epoch ms')
  t.ok(Number.isSafeInteger(ready.at) && ready.at >= ws.at && ready.at <= before, 'ready.at is a plausible epoch ms, after ws.at')

  child.kill('SIGTERM')
  t.is(await exited, 0, 'seed exits 0')
  const stopped = events().find((e) => e.event === 'stopped')
  t.ok(stopped, 'stopped event logged')
  if (!stopped) return
  t.ok(Number.isSafeInteger(stopped.drainMs) && stopped.drainMs >= 0, 'drainMs >= 0')
  t.ok(Number.isSafeInteger(stopped.closeMs) && stopped.closeMs >= stopped.drainMs, 'closeMs >= drainMs')
  t.ok(Number.isSafeInteger(stopped.stopListeningAt) && stopped.stopListeningAt >= before && stopped.stopListeningAt <= Date.now(), 'stopListeningAt is a plausible epoch ms after the signal was sent')
  t.alike(Object.keys(stopped).sort(), ['closeMs', 'drainMs', 'event', 'stopListeningAt'], 'no other fields')
})
