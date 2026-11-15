'use strict'

// The real `varanda account` start (apps/cli/lib/commands/account.js) with
// the hosted age check on, spawned as a child on 127.0.0.1: the age-since
// floors reach /account/age/since through serve itself, not through a server
// built by hand (account-age.test.js). Keys are generated here, Didit is
// never called (no session is opened) and nothing leaves the machine.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { verifyAgeSince } = require('@varanda/core/lib/age-proof')
const { openAccountStore } = require('../lib/account/store')
const { openAgeStore } = require('../lib/account/age-store')
const { loadIssuer } = require('../lib/account/server')
const { RETRY_MS } = require('../lib/account/age-check-state')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const SINCE = '2026-02-01T00:00:00.000Z'
const ENABLED_AT = '2026-03-01T00:00:00.000Z'
const BAND_AT = '2026-01-05T10:00:00.000Z'
const ENV = {
  VARANDA_PUBLIC_ORIGIN: 'https://varanda.test',
  VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste',
  VARANDA_DIDIT_API_KEY: 'didit-key-age-serve-0123456789',
  VARANDA_DIDIT_WORKFLOW_ID: '11111111-2222-4333-8444-555555555555',
  VARANDA_AGE_SINCE: SINCE
}

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function varanda (dir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function memberHex () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

// A configured account dir: issuer key and certificate of a fresh association.
function accountDir (t) {
  const dir = path.join(tmpDir(t), 'account')
  const assocKp = crypto.keyPair()
  const association = b4a.toString(assocKp.publicKey, 'hex')
  const key = varanda(dir, ['account', 'key', '--association', association, '--json'])
  if (key.code !== 0) throw new Error(key.stderr)
  const issuer = JSON.parse(key.stdout).publicKey
  const certFile = path.join(tmpDir(t), 'issuer-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createIssuerCert({ issuer }, assocKp)))
  const added = varanda(dir, ['account', 'cert', 'add', '--cert-file', certFile])
  if (added.code !== 0) throw new Error(added.stderr)
  return { dir, association }
}

let subSeq = 0

// Links `member` (a fresh key by default) in the directory.
async function linkMember (dir, association, username, member = memberHex()) {
  const issuer = loadIssuer(dir, association)
  const store = openAccountStore(dir)
  const row = store.start({ member, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '50000000000000000' + String(10000 + subSeq++), email: 'membro@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, issuer.keyPair, issuer.cert, association)
  await store.close()
}

async function until (fn, ms = 20000, every = 20) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((resolve) => setTimeout(resolve, every))
  }
  return null
}

// Spawns `account` until 'ready'.
async function serve (t, dir) {
  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], { env: { ...cleanEnv, ...ENV } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  t.teardown(() => { child.kill('SIGKILL') }, { force: true })
  const events = () => stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const ready = await until(() => events().find((e) => e.event === 'ready'))
  t.ok(ready, 'ready: ' + stderr)
  const port = events().find((e) => e.event === 'listening').port
  return {
    since: async () => {
      const res = await fetch('http://127.0.0.1:' + port + '/account/age/since')
      return { status: res.status, body: await res.json() }
    },
    output: () => stdout,
    has: (event) => stdout.split('\n').includes(JSON.stringify(event)),
    stop: async () => {
      child.kill('SIGTERM')
      return exited
    }
  }
}

test('serve: VARANDA_AGE_SINCE with the Didit pair serves both the enabledAt floor and the directory floor', async (t) => {
  t.timeout(90000)
  const { dir, association } = accountDir(t)
  // A banded member who linked: the age sweep keeps a linked member's band.
  const banded = memberHex()
  await openAgeStore(dir).record({ member: banded, band: '18+', method: 'didit', checkedAt: BAND_AT })
  await linkMember(dir, association, 'bia', banded)
  fs.writeFileSync(path.join(dir, 'age-check.json'), JSON.stringify({ v: 1, on: true, enabledAt: ENABLED_AT }))

  // The check was last turned on after since: age-check.json lifts it.
  const first = await serve(t, dir)
  const a = await first.since()
  t.is(a.status, 200)
  t.is(a.body.since.since, ENABLED_AT, 'the enabledAt floor reaches the route')
  t.alike(verifyAgeSince(a.body.since, association), { ok: true })
  t.absent(first.has({ event: 'idade', reason: 'estado-indisponivel' }))
  t.is(await first.stop(), 0)

  // A link with no band, dated after both: the directory floor lifts it.
  await linkMember(dir, association, 'ana')
  const linkedAt = openAccountStore(dir, { readOnly: true }).exportLinks().find((l) => l.member !== banded).linkedAt
  t.ok(linkedAt > ENABLED_AT)
  const second = await serve(t, dir)
  const b = await second.since()
  t.is(b.status, 200)
  t.is(b.body.since.since, new Date(Date.parse(linkedAt) + 1).toISOString(), 'the directory floor reaches the route')
  t.alike(verifyAgeSince(b.body.since, association), { ok: true })
  t.is(await second.stop(), 0)
})

test('serve: an age-check.json unreadable at start answers 503, then recovers without a restart', async (t) => {
  t.timeout(120000)
  const { dir, association } = accountDir(t)
  const banded = memberHex()
  await openAgeStore(dir).record({ member: banded, band: '18+', method: 'didit', checkedAt: BAND_AT })
  await linkMember(dir, association, 'bia', banded)
  const file = path.join(dir, 'age-check.json')
  fs.writeFileSync(file, 'not json')

  const svc = await serve(t, dir)
  t.ok(svc.has({ event: 'idade', reason: 'estado-indisponivel' }), 'logged at start')
  const down = await svc.since()
  t.is(down.status, 503)
  t.alike(down.body, { error: 'indisponivel' })

  fs.writeFileSync(file, JSON.stringify({ v: 1, on: true, enabledAt: ENABLED_AT }))
  // The retry waits RETRY_MS between attempts.
  const back = await until(async () => {
    const r = await svc.since()
    return r.status === 200 ? r : null
  }, RETRY_MS + 20000, 1000)
  t.ok(back, 'a later request recovers, with no restart')
  t.is(back && back.body.since.since, ENABLED_AT)
  t.is(await svc.stop(), 0)
})

test('serve: an age.json unreadable at start answers 503, then recovers without a restart', async (t) => {
  t.timeout(120000)
  const { dir, association } = accountDir(t)
  const member = memberHex()
  await linkMember(dir, association, 'bia', member)
  const file = path.join(dir, 'age.json')
  fs.writeFileSync(file, 'not json')
  fs.writeFileSync(path.join(dir, 'age-check.json'), JSON.stringify({ v: 1, on: true, enabledAt: ENABLED_AT }))

  const svc = await serve(t, dir)
  t.ok(svc.has({ event: 'idade', reason: 'indisponivel' }), 'the store is unavailable at start')
  t.is((await svc.since()).status, 503)

  fs.writeFileSync(file, JSON.stringify({ v: 1, members: { [member]: { band: '18+', method: 'didit', checkedAt: BAND_AT } } }))
  // The heartbeat re-reads the file, then the floors retry (RETRY_MS apart).
  const back = await until(async () => {
    const r = await svc.since()
    return r.status === 200 ? r : null
  }, RETRY_MS + 30000, 1000)
  t.ok(back, 'a later request recovers, with no restart')
  t.is(back && back.body.since.since, ENABLED_AT)
  t.is(await svc.stop(), 0)
})

test('serve: the age sweep runs at start and forgets only an unlinked band older than 30 days', async (t) => {
  t.timeout(60000)
  const { dir, association } = accountDir(t)
  const stale = memberHex()
  const linked = memberHex()
  const young = memberHex()
  const youngAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString()
  const ages = openAgeStore(dir)
  await ages.record({ member: stale, band: '18+', method: 'didit', checkedAt: BAND_AT })
  await ages.record({ member: linked, band: '16-17', method: 'didit', checkedAt: BAND_AT })
  await ages.record({ member: young, band: '18+', method: 'didit', checkedAt: youngAt })
  await linkMember(dir, association, 'bia', linked)

  const svc = await serve(t, dir)
  const members = await until(() => {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'age.json'), 'utf8')).members
    return m[stale] === undefined ? m : null
  }, 20000, 100)
  t.ok(members, 'the stale unlinked band is forgotten without a request')
  t.ok(members && members[linked] !== undefined, 'a linked member keeps its band')
  t.ok(members && members[young] !== undefined, 'a younger band is kept')
  t.ok(await until(() => svc.has({ event: 'idade', reason: 'varridas', count: 1 }), 5000, 50), 'a count is logged')
  t.absent(svc.output().includes(stale), 'no key in the log')
  t.is(await svc.stop(), 0)
})
