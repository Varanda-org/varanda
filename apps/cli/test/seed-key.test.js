const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const { testnet, tmpDir } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

test('cli: seed key and seed without association', async (t) => {
  t.timeout(90000)
  await testnet(t)
  const assoc = makeAssociation()
  const env = { ...process.env }
  delete env.VARANDA_ASSOCIATION
  delete env.VARANDA_DATA
  delete env.VARANDA_BOOTSTRAP

  const dir = tmpDir(t, 'varanda-cli-')
  const r1 = spawnSync(process.execPath, [BIN, 'seed', 'key', '--data', dir, '--association', assoc.hex], { env, encoding: 'utf8' })
  t.is(r1.status, 0, r1.stderr)
  const match = /chave do semeador: ([0-9a-f]{64})\n$/.exec(r1.stdout)
  t.ok(match, r1.stdout)
  t.is(fs.statSync(path.join(dir, 'seeder-key.json')).mode & 0o777, 0o600)
  const r2 = spawnSync(process.execPath, [BIN, 'seed', 'key', '--data', dir, '--json'], { env, encoding: 'utf8' })
  t.is(r2.status, 0, r2.stderr)
  t.alike(JSON.parse(r2.stdout.trim()), { publicKey: match && match[1] })

  const empty = tmpDir(t, 'varanda-cli-')
  const r3 = spawnSync(process.execPath, [BIN, 'seed', '--data', empty], { env, encoding: 'utf8' })
  t.is(r3.status, 2, r3.stderr)
  t.ok(r3.stderr.includes('informe --association ou VARANDA_ASSOCIATION'))
})
