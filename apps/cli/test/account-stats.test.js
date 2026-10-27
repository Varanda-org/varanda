'use strict'

// The usage statistics wiring of commands/account.js: VARANDA_STATS_EMAILS
// and VARANDA_SEEDER_HEALTH parsed by readEnv (never echoed), the CLI
// refusing a stats admin who is not a moderator, the real store, seeder
// reader and usage sampler glued together against a loopback fake /health,
// and the running service leaving the seeder alone while stats are off. No
// socket leaves 127.0.0.1: the fake seeder and the service bind loopback.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { localDay } = require('@varanda/core/lib/activity')
const { openAccountStore } = require('../lib/account/store')
const { createSeederHealthReader } = require('../lib/account/seeder-health')
const { createUsageStats } = require('../lib/account/usage-stats')
const { readEnv } = require('../lib/commands/account')
const { UsageError } = require('../lib/cli')
const { tmpDir, until } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
const HEX64 = /[0-9a-f]{64}/
const HEALTH = { status: 'ok', uptimeSeconds: 10, admitted: 2, activeDay: 1, activeWeek: 2, blocks: 3, bytes: 10, mediaBytes: 0, topicPosts: 1, connections: 1, external: 0 }

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

const BASE = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
const MODS = { ...BASE, VARANDA_MODERATOR_EMAILS: 'mod@x.test,b@x.test' }

function varanda (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function keys () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association, assoc }
}

async function linkDirect (accounts, iss, m, username, sub, email) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

// A loopback stand-in for the seeder's GET /health; counts every request.
async function fakeSeeder (t, body = HEALTH) {
  const hits = { n: 0 }
  const server = http.createServer((req, res) => {
    hits.n++
    const text = JSON.stringify(body)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  return { hits, url: 'http://127.0.0.1:' + server.address().port }
}

function throwsMessage (t, fn, message, Class, value) {
  try {
    fn()
    t.fail('accepted: ' + message)
  } catch (err) {
    t.is(err.message, message)
    t.ok(err instanceof Class)
    if (Class === Error) t.absent(err instanceof UsageError, 'exit 1, not a usage error')
    if (value !== undefined) t.absent(err.message.includes(value), 'the value is never in the message')
  }
}

test('readEnv: VARANDA_STATS_EMAILS a subset of the moderators; VARANDA_SEEDER_HEALTH only while stats are on', (t) => {
  const off = readEnv(MODS, '/data')
  t.alike(off.statsEmails, [], 'unset: no stats admins')
  t.is(off.seederHealth, null, 'unset: no seeder health URL')
  t.alike(readEnv({ ...MODS, VARANDA_STATS_EMAILS: '' }, '/data').statsEmails, [], 'empty: off')

  const on = readEnv({ ...MODS, VARANDA_STATS_EMAILS: 'MOD@x.test' }, '/data')
  t.alike(on.statsEmails, ['mod@x.test'], 'lowercased')
  t.is(on.seederHealth, 'http://127.0.0.1:8788', 'the default seeder health URL')

  for (const value of ['c@x.test', 'sem-arroba']) {
    throwsMessage(t, () => readEnv({ ...MODS, VARANDA_STATS_EMAILS: value }, '/data'), 'VARANDA_STATS_EMAILS inválido', Error, value)
  }
  throwsMessage(t, () => readEnv({ ...BASE, VARANDA_STATS_EMAILS: 'mod@x.test' }, '/data'), 'VARANDA_STATS_EMAILS inválido', Error, 'mod@x.test')

  const stats = { ...MODS, VARANDA_STATS_EMAILS: 'mod@x.test' }
  t.is(readEnv({ ...stats, VARANDA_SEEDER_HEALTH: 'http://localhost:9000/' }, '/data').seederHealth, 'http://localhost:9000', 'trailing / dropped')
  throwsMessage(t, () => readEnv({ ...stats, VARANDA_SEEDER_HEALTH: 'http://10.0.0.1:8788' }, '/data'), 'VARANDA_SEEDER_HEALTH inválido', UsageError, '10.0.0.1')
  const ignored = readEnv({ ...MODS, VARANDA_SEEDER_HEALTH: 'http://10.0.0.1:8788' }, '/data')
  t.is(ignored.seederHealth, null, 'stats off: the variable is ignored')
})

test('account (CLI): a stats admin who is not a moderator is refused without echo', (t) => {
  const root = tmpDir(t)
  const iss = issuer()
  const env = { ...MODS, VARANDA_STATS_EMAILS: 'segredo@fora.test' }
  const bad = varanda(path.join(root, 'account'), ['account', '--account-port', '0', '--association', iss.association], env)
  t.is(bad.code, 1)
  t.ok(bad.stderr.includes('VARANDA_STATS_EMAILS inválido'), bad.stderr)
  t.absent(bad.stderr.includes('segredo@fora.test') || bad.stdout.includes('segredo@fora.test'), 'the value is never printed')
})

test('glue: real store, seeder reader and sampler; usage.json 0o600 with counts only', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  // 23:00 in Brasília on 2026-10-26 (02:00 UTC on the 27th): the history
  // and the sign-up buckets use the Brasília day, not the UTC one.
  const NOW = Date.UTC(2026, 9, 27, 2, 0, 0)
  const now = () => NOW
  const iss = issuer()
  const accounts = openAccountStore(dir, { now })
  t.teardown(() => accounts.close().catch(() => {}), { force: true })
  await linkDirect(accounts, iss, keys(), 'ana', '1111111111111111111111', 'ana@example.test')
  await linkDirect(accounts, iss, keys(), 'bia', '2222222222222222222222', 'bia@example.test')

  const seeder = await fakeSeeder(t)
  const reader = createSeederHealthReader({ baseUrl: seeder.url })
  const usage = createUsageStats({ dataDir: dir, accounts, readSeeder: () => reader.read(), now, dayOf: localDay })
  const view = await usage.view()
  t.is(view.members.total, 2)
  t.is(view.seeder.admitted, 2)
  t.is(view.seeder.activeDay, 1)
  t.is(view.signups.weeks[view.signups.weeks.length - 1].count, 2, 'both in the current week')
  t.is(view.signups.months[view.signups.months.length - 1].total, 2, 'both by the current month')
  t.is(view.history.length, 1)
  t.is(view.history[0].day, localDay(NOW))
  t.is(view.history[0].day, '2026-10-26', 'the Brasília day')
  t.is(seeder.hits.n, 1)

  await usage.stop()
  const file = path.join(dir, 'usage.json')
  t.ok(fs.existsSync(file), 'usage.json written on stop')
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  const raw = fs.readFileSync(file, 'utf8')
  t.absent(HEX64.test(raw), 'no key')
  t.absent(raw.includes('@'), 'no e-mail')
  t.is(JSON.parse(raw).days.length, 1)
})

// Spawns `account` on a free port; -> { stop(), stdout() }.
function serveCli (t, dir, env) {
  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], { env: { ...cleanEnv, ...env } })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', () => {})
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  t.teardown(() => { child.kill('SIGKILL') }, { force: true })
  return {
    stdout: () => stdout,
    stop: () => {
      child.kill('SIGTERM')
      return exited
    }
  }
}

test('account (serve): stats off never contacts the seeder nor writes usage.json; on logs ligada', async (t) => {
  t.timeout(60000)
  const root = tmpDir(t)
  const iss = issuer()
  const seeder = await fakeSeeder(t)
  const env = { ...MODS, VARANDA_ASSOCIATION: iss.association, VARANDA_SEEDER_HEALTH: seeder.url }

  const offDir = path.join(root, 'off')
  const off = serveCli(t, offDir, env)
  t.ok(await until(() => off.stdout().includes(JSON.stringify({ event: 'ready', configured: false })), { name: 'ready (off)' }))
  t.ok(off.stdout().includes(JSON.stringify({ event: 'usage', reason: 'desligada' })))
  t.is(await off.stop(), 0)
  t.is(seeder.hits.n, 0, 'the health endpoint is never contacted')
  t.absent(fs.existsSync(path.join(offDir, 'usage.json')), 'no usage.json')

  const onDir = path.join(root, 'on')
  const on = serveCli(t, onDir, { ...env, VARANDA_STATS_EMAILS: 'mod@x.test' })
  t.ok(await until(() => on.stdout().includes(JSON.stringify({ event: 'ready', configured: false })), { name: 'ready (on)' }))
  t.ok(on.stdout().includes(JSON.stringify({ event: 'usage', reason: 'ligada' })))
  t.absent(on.stdout().includes('mod@x.test'), 'the e-mail is never logged')
  t.is(await on.stop(), 0)
})
