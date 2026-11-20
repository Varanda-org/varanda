'use strict'

// apps/cli/lib/commands/account.js and phone verification: the
// VARANDA_PHONE_KEY and VARANDA_PHONE_DAILY_LIMIT switches, what serve logs
// with and without the key, and the operator's `account phone` command
// (reveal for a court order, --release under the service lock). Keys are
// generated here and nothing reaches the network: the services spawned here
// never call the provider.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { openPhoneStore, FILE } = require('../lib/account/phone-store')
const { openAgeStore } = require('../lib/account/age-store')
const { openAccountStore } = require('../lib/account/store')
const { takeLock } = require('../lib/account/server')
const { readEnv, releasePhone } = require('../lib/commands/account')
const { UsageError } = require('../lib/cli')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ENV = {
  VARANDA_PUBLIC_ORIGIN: 'https://varanda.test',
  VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste'
}
const DIDIT = {
  VARANDA_DIDIT_API_KEY: 'didit-key-phone-cli-0123456789',
  VARANDA_DIDIT_WORKFLOW_ID: '11111111-2222-4333-8444-555555555555'
}
const PHONE = '+5511987654321'
const DIGITS = '11987654321'
const KEY_INVALID = 'VARANDA_PHONE_KEY inválida: use 64 caracteres hexadecimais minúsculos'
const NEEDS_AGE = 'VARANDA_PHONE_KEY exige a verificação de idade ligada (VARANDA_DIDIT_API_KEY e VARANDA_DIDIT_WORKFLOW_ID).'
const CBS = { linked: () => false, burnable: () => false, deleted: () => false }

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function varanda (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function association () {
  return issuer().association
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

function memberHex () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function hexKey () {
  return nodeCrypto.randomBytes(32).toString('hex')
}

function usageError (t, env, message, label) {
  try {
    readEnv(env)
    t.fail(label + ': accepted')
  } catch (err) {
    t.ok(err instanceof UsageError, label + ': usage error')
    t.is(err.message, message, label)
  }
}

// An account dir (config.json and the issuer key) holding one verified
// number for `member` under `key`.
async function accountDir (t, { member = memberHex(), key = hexKey(), phone = true } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const created = varanda(dir, ['account', 'key', '--association', association()])
  t.is(created.code, 0, created.stderr)
  if (phone) {
    const store = openPhoneStore(dir, { key: Buffer.from(key, 'hex') })
    await store.record({ member, phone: PHONE }, CBS)
  }
  return { dir, member, key }
}

async function until (fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return null
}

// Spawns `account` on a free port until 'ready', -> { port, stdout(), stop() }.
async function serve (t, dir, env) {
  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], { env: { ...cleanEnv, ...ENV, ...env } })
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
    port,
    stdout: () => stdout,
    stderr: () => stderr,
    has: (event) => stdout.split('\n').includes(JSON.stringify(event)),
    stop: async () => {
      child.kill('SIGTERM')
      return exited
    }
  }
}

test('readEnv: VARANDA_PHONE_KEY unset or empty is off, even with the age check on', (t) => {
  t.is(readEnv(ENV).phone, null, 'unset: off')
  t.is(readEnv({ ...ENV, VARANDA_PHONE_KEY: '' }).phone, null, 'empty: off')
  t.is(readEnv({ ...ENV, ...DIDIT }).phone, null, 'age on, key unset: off')
  t.is(readEnv({ ...ENV, ...DIDIT, VARANDA_PHONE_DAILY_LIMIT: 'abc' }).phone, null, 'the limit is ignored while off')
})

test('readEnv: a key with the age pair is on, with a daily limit of 200 by default', (t) => {
  const key = hexKey()
  const on = readEnv({ ...ENV, ...DIDIT, VARANDA_PHONE_KEY: key }).phone
  t.ok(Buffer.isBuffer(on.key) && on.key.length === 32, 'a 32-byte key')
  t.is(on.key.toString('hex'), key)
  t.is(on.dailyLimit, 200)
  t.is(readEnv({ ...ENV, ...DIDIT, VARANDA_PHONE_KEY: key, VARANDA_PHONE_DAILY_LIMIT: '50' }).phone.dailyLimit, 50)
  t.is(readEnv({ ...ENV, ...DIDIT, VARANDA_PHONE_KEY: key, VARANDA_PHONE_DAILY_LIMIT: '' }).phone.dailyLimit, 200, 'empty: default')
  t.is(readEnv({ ...ENV, ...DIDIT, VARANDA_PHONE_KEY: key, VARANDA_PHONE_DAILY_LIMIT: '100000' }).phone.dailyLimit, 100000)
})

test('readEnv: a malformed key, a key without the age pair and a bad limit are refused without the value', (t) => {
  const key = hexKey()
  for (const bad of [key.toUpperCase(), key.slice(1), key + '0', 'zz' + key.slice(2), ' ' + key, key + '\n']) {
    usageError(t, { ...ENV, ...DIDIT, VARANDA_PHONE_KEY: bad }, KEY_INVALID, 'malformed key')
  }
  usageError(t, { ...ENV, VARANDA_PHONE_KEY: key }, NEEDS_AGE, 'key without the age pair')
  usageError(t, { ...ENV, VARANDA_DIDIT_API_KEY: '', VARANDA_DIDIT_WORKFLOW_ID: '', VARANDA_PHONE_KEY: key }, NEEDS_AGE, 'key with an empty age pair')
  for (const limit of ['0', '100001', '01', 'abc', '1e3', '-1', '2.5']) {
    usageError(t, { ...ENV, ...DIDIT, VARANDA_PHONE_KEY: key, VARANDA_PHONE_DAILY_LIMIT: limit }, 'VARANDA_PHONE_DAILY_LIMIT inválido', 'limit ' + limit)
  }

  const dir = path.join(tmpDir(t), 'account')
  const bad = key.toUpperCase()
  const r = varanda(dir, ['account'], { ...ENV, ...DIDIT, VARANDA_PHONE_KEY: bad })
  t.is(r.code, 2)
  t.ok(r.stderr.startsWith('uso: ' + KEY_INVALID + '\n'), r.stderr)
  t.absent((r.stdout + r.stderr).toLowerCase().includes(key), 'the key is never printed')
})

test('readEnv: VARANDA_PHONE_REVIEW lists up to four member keys, read only while the phone check is on', (t) => {
  const key = hexKey()
  const on = { ...ENV, ...DIDIT, VARANDA_PHONE_KEY: key }
  const a = memberHex()
  const b = memberHex()
  t.alike(readEnv(on).phone.review, [], 'unset: none')
  t.alike(readEnv({ ...on, VARANDA_PHONE_REVIEW: '' }).phone.review, [], 'empty: none')
  t.alike(readEnv({ ...on, VARANDA_PHONE_REVIEW: '  ' }).phone.review, [], 'blank: none')
  t.alike(readEnv({ ...on, VARANDA_PHONE_REVIEW: a }).phone.review, [a])
  t.alike(readEnv({ ...on, VARANDA_PHONE_REVIEW: ' ' + a + ' , ' + b + ' ' }).phone.review, [a, b], 'spaces around the keys are trimmed')
  const four = [a, b, memberHex(), memberHex()]
  t.alike(readEnv({ ...on, VARANDA_PHONE_REVIEW: four.join(',') }).phone.review, four, 'four keys')
  t.is(readEnv({ ...ENV, ...DIDIT, VARANDA_PHONE_REVIEW: 'not-a-key' }).phone, null, 'ignored while off')

  for (const [bad, label] of [
    [a.toUpperCase(), 'uppercase'],
    [a.slice(1), 'short'],
    [a + ',', 'trailing comma'],
    [a + ';' + b, 'another separator'],
    [a + ',' + a, 'repeated key'],
    [[...four, memberHex()].join(','), 'five keys']
  ]) {
    try {
      readEnv({ ...on, VARANDA_PHONE_REVIEW: bad })
      t.fail(label + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, label + ': usage error')
      t.is(err.message, 'VARANDA_PHONE_REVIEW inválida: use até 4 chaves de membro diferentes (64 caracteres hexadecimais minúsculos) separadas por vírgula', label)
      t.absent(err.message.toLowerCase().includes(a.slice(0, 16)), label + ': no key in the message')
    }
  }
})

test('serve: without the key nothing about phones runs, and a leftover phone.json is logged once', async (t) => {
  t.timeout(60000)
  const { dir } = await accountDir(t, { phone: false })
  const off = await serve(t, dir, { VARANDA_PHONE_REVIEW: memberHex() })
  t.ok(off.has({ event: 'telefone', reason: 'desligada' }), 'off')
  t.absent(off.has({ event: 'telefone', reason: 'contas-de-revisao' }), 'a review list is not read while off')
  t.absent(off.has({ event: 'telefone', reason: 'arquivo-sem-chave' }), 'no file, no warning')
  const policy = await fetch('http://127.0.0.1:' + off.port + '/account/phone/policy')
  t.alike(await policy.json(), { required: false })
  t.is(await off.stop(), 0)
  t.absent(fs.existsSync(path.join(dir, FILE)), 'serve creates no phone.json')

  const store = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32) })
  await store.record({ member: memberHex(), phone: PHONE }, CBS)
  const left = await serve(t, dir, {})
  t.is(left.stdout().split('\n').filter((l) => l === JSON.stringify({ event: 'telefone', reason: 'arquivo-sem-chave' })).length, 1, 'logged once')
  t.ok(left.has({ event: 'telefone', reason: 'desligada' }))
  t.is(await left.stop(), 0)
})

test('serve: a key that does not open phone.json keeps the feature required', async (t) => {
  t.timeout(60000)
  const { dir } = await accountDir(t)
  const wrong = hexKey()
  const svc = await serve(t, dir, { ...DIDIT, VARANDA_PHONE_KEY: wrong })
  t.ok(svc.has({ event: 'telefone', reason: 'indisponivel' }), 'the store is unavailable')
  t.ok(svc.has({ event: 'telefone', reason: 'ligada' }), 'and the feature is on')
  const policy = await fetch('http://127.0.0.1:' + svc.port + '/account/phone/policy')
  t.alike(await policy.json(), { required: true }, 'the gates stay shut')
  const out = svc.stdout() + svc.stderr()
  t.absent(out.includes(wrong), 'the key is never logged')
  t.absent(out.includes(DIGITS), 'no number in the log')
  t.is(await svc.stop(), 0)

  const right = await accountDir(t)
  const reviewer = memberHex()
  const on = await serve(t, right.dir, { ...DIDIT, VARANDA_PHONE_KEY: right.key, VARANDA_PHONE_REVIEW: reviewer })
  t.ok(on.has({ event: 'telefone', reason: 'ligada' }))
  t.ok(on.has({ event: 'telefone', reason: 'contas-de-revisao' }), 'the review list is logged as on')
  t.absent(on.has({ event: 'telefone', reason: 'indisponivel' }))
  t.absent((on.stdout() + on.stderr()).includes(DIGITS), 'no number in the log')
  t.absent((on.stdout() + on.stderr()).includes(reviewer), 'never the review key')
  t.is(await on.stop(), 0)
})

test('account phone --waiting: unlinked keys with an age band, newest first, at most 10, with no key and under the lock', async (t) => {
  const { dir } = await accountDir(t, { phone: false })
  const ages = openAgeStore(dir)
  const base = Date.parse('2026-11-18T10:00:00.000Z')
  const waiting = []
  for (let i = 0; i < 12; i++) {
    const m = memberHex()
    const checkedAt = new Date(base + i * 60000).toISOString()
    await ages.record({ member: m, band: '18+', method: 'didit', checkedAt })
    waiting.push({ member: m, checkedAt })
  }
  // The newest band belongs to a key that has linked since: never listed.
  const linked = memberHex()
  await ages.record({ member: linked, band: '18+', method: 'didit', checkedAt: new Date(base + 3600000).toISOString() })
  const iss = issuer()
  const store = openAccountStore(dir)
  const row = store.start({ member: linked, username: 'ana' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '600000000000000000001', email: 'a@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)

  const lock = takeLock(dir)
  t.teardown(() => lock.release())
  const before = fs.readFileSync(path.join(dir, 'age.json'))
  const r = varanda(dir, ['account', 'phone', '--waiting'])
  t.is(r.code, 0, r.stderr)
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
  t.alike(lines, waiting.slice(-10).reverse(), 'the 10 newest unlinked keys, newest first, { member, checkedAt } only')
  t.absent(r.stdout.includes(linked), 'a linked key is never listed')
  t.ok(lock.owned(), 'the lock is untouched')
  t.alike(fs.readFileSync(path.join(dir, 'age.json')), before, 'age.json unchanged')

  for (const extra of [['--member', memberHex()], ['--username', 'ana'], ['--release']]) {
    const bad = varanda(dir, ['account', 'phone', '--waiting', ...extra])
    t.is(bad.code, 2, extra[0])
    t.ok(bad.stderr.startsWith('uso: use --waiting sozinho\n'), bad.stderr)
  }
})

test('account phone --waiting: an empty store prints nothing', async (t) => {
  const { dir } = await accountDir(t, { phone: false })
  const r = varanda(dir, ['account', 'phone', '--waiting'])
  t.is(r.code, 0, r.stderr)
  t.is(r.stdout, '')
})

test('account phone: prints the number as one JSON line only with --member and the key', async (t) => {
  const { dir, member, key } = await accountDir(t)
  const r = varanda(dir, ['account', 'phone', '--member', member], { VARANDA_PHONE_KEY: key })
  t.is(r.code, 0, r.stderr)
  t.is(r.stderr, '')
  const lines = r.stdout.split('\n')
  t.is(lines.length, 2, 'one line')
  t.is(lines[1], '')
  const out = JSON.parse(lines[0])
  t.alike(Object.keys(out), ['member', 'rows'])
  t.is(out.member, member)
  t.is(out.rows.length, 1)
  t.is(out.rows[0].phone, PHONE)
  t.is(out.rows[0].end, null)
  t.is(out.rows[0].endedAt, null)
  t.is(out.rows[0].burned, false)
  t.ok(typeof out.rows[0].verifiedAt === 'string')
  t.absent(r.stdout.includes(key), 'the key is never printed')

  const noMember = varanda(dir, ['account', 'phone'], { VARANDA_PHONE_KEY: key })
  t.is(noMember.code, 2, 'without --member: usage')
  t.is(noMember.stdout, '')

  const noKey = varanda(dir, ['account', 'phone', '--member', member])
  t.is(noKey.code, 1)
  t.is(noKey.stderr, 'erro: VARANDA_PHONE_KEY ausente\n')
  t.is(noKey.stdout, '')

  const malformed = varanda(dir, ['account', 'phone', '--member', member], { VARANDA_PHONE_KEY: key.toUpperCase() })
  t.is(malformed.code, 1)
  t.is(malformed.stderr, 'erro: ' + KEY_INVALID + '\n')
  t.absent(malformed.stderr.toLowerCase().includes(key), 'the value is not echoed')

  const wrongKey = varanda(dir, ['account', 'phone', '--member', member], { VARANDA_PHONE_KEY: hexKey() })
  t.is(wrongKey.code, 1)
  t.is(wrongKey.stderr, 'erro: phone.json inválido\n')
  t.is(wrongKey.stdout, '')

  const other = varanda(dir, ['account', 'phone', '--member', memberHex()], { VARANDA_PHONE_KEY: key })
  t.is(other.code, 1)
  t.is(other.stderr, 'erro: sem telefone registrado\n')
  t.is(other.stdout, '')

  for (const res of [noMember, noKey, malformed, wrongKey, other]) t.absent(res.stderr.includes(DIGITS), 'stderr never has the number')
})

test('account phone: reads while the service lock is held, and writes nothing', async (t) => {
  const { dir, member, key } = await accountDir(t)
  const before = fs.readFileSync(path.join(dir, FILE))
  const lock = takeLock(dir)
  t.teardown(() => lock.release())
  const r = varanda(dir, ['account', 'phone', '--member', member], { VARANDA_PHONE_KEY: key })
  t.is(r.code, 0, r.stderr)
  t.is(JSON.parse(r.stdout).rows[0].phone, PHONE)
  t.ok(lock.owned(), 'the lock is untouched')
  t.alike(fs.readFileSync(path.join(dir, FILE)), before, 'phone.json unchanged')
})

test('account phone --release: refuses while the service holds the lock, releases otherwise, never prints the number', async (t) => {
  const { dir, member, key } = await accountDir(t)
  const file = path.join(dir, FILE)
  const before = fs.readFileSync(file)

  const lock = takeLock(dir)
  const held = varanda(dir, ['account', 'phone', '--release', '--member', member], { VARANDA_PHONE_KEY: key })
  lock.release()
  t.is(held.code, 1)
  t.is(held.stderr, 'erro: pare o serviço de conta antes de liberar um número\n')
  t.is(held.stdout, '')
  t.alike(fs.readFileSync(file), before, 'nothing written while the service runs')

  const r = varanda(dir, ['account', 'phone', '--release', '--member', member], { VARANDA_PHONE_KEY: key })
  t.is(r.code, 0, r.stderr)
  t.is(r.stderr, '')
  t.is(r.stdout, JSON.stringify({ member, released: true, rows: 1 }) + '\n')
  t.absent(r.stdout.includes(DIGITS), 'no digit of the number')
  t.absent(fs.existsSync(path.join(dir, '.account-lock')), 'the lock is released')
  const reveal = openPhoneStore(dir, { key: Buffer.from(key, 'hex'), readOnly: true, disclose: true }).reveal(member)
  t.is(reveal.length, 1)
  t.is(reveal[0].end, 'liberado', 'the row is ended as released')
  t.is(reveal[0].phone, PHONE, 'the seal is kept')

  const again = varanda(dir, ['account', 'phone', '--release', '--member', member], { VARANDA_PHONE_KEY: key })
  t.is(again.code, 0, 'a second release is idempotent')
  t.is(again.stdout, JSON.stringify({ member, released: true, alreadyReleased: true, rows: 1 }) + '\n')

  const nobody = varanda(dir, ['account', 'phone', '--release', '--member', memberHex()], { VARANDA_PHONE_KEY: key })
  t.is(nobody.code, 1)
  t.is(nobody.stderr, 'erro: sem telefone registrado\n')

  const malformed = varanda(dir, ['account', 'phone', '--release', '--member', 'xyz'], { VARANDA_PHONE_KEY: key })
  t.is(malformed.code, 2)
  t.ok(malformed.stderr.startsWith('uso: chave inválida\n'), malformed.stderr)
  t.is(malformed.stdout, '')

  const noKey = varanda(dir, ['account', 'phone', '--release', '--member', member])
  t.is(noKey.code, 1)
  t.is(noKey.stderr, 'erro: VARANDA_PHONE_KEY ausente\n')

  for (const res of [held, r, again, nobody, malformed, noKey]) t.absent((res.stdout + res.stderr).includes(DIGITS), 'never the number')
})

test('account phone --release: a member released earlier whose rows are gone is confirmed, not refused', async (t) => {
  const { dir, member, key } = await accountDir(t)
  const file = path.join(dir, FILE)
  const first = varanda(dir, ['account', 'phone', '--release', '--member', member], { VARANDA_PHONE_KEY: key })
  t.is(first.code, 0, first.stderr)

  // What the 180-day strip leaves: the release mark without any row.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.ok(Object.hasOwn(doc.released, member))
  doc.rows = doc.rows.filter((r) => r.member !== member)
  fs.writeFileSync(file, JSON.stringify(doc))
  const stripped = fs.readFileSync(file)

  const r = varanda(dir, ['account', 'phone', '--release', '--member', member], { VARANDA_PHONE_KEY: key })
  t.is(r.code, 0, r.stderr)
  t.is(r.stderr, '')
  t.is(r.stdout, JSON.stringify({ member, released: true, alreadyReleased: true, rows: 0 }) + '\n')
  t.alike(fs.readFileSync(file), stripped, 'nothing written')

  const nobody = varanda(dir, ['account', 'phone', '--release', '--member', memberHex()], { VARANDA_PHONE_KEY: key })
  t.is(nobody.code, 1)
  t.is(nobody.stderr, 'erro: sem telefone registrado\n')
  for (const res of [first, r, nobody]) t.absent((res.stdout + res.stderr).includes(DIGITS), 'never the number')
})

test('account phone --release: a failed write is not called an invalid file, a store that does not open is', async (t) => {
  const { dir, member, key } = await accountDir(t)
  const file = path.join(dir, FILE)
  const before = fs.readFileSync(file)

  // The guard refuses on its second call, the one just before the write:
  // the old file stays and the store cannot tell whether the rename landed.
  const refuseWrite = (dataDir, opts) => {
    let calls = 0
    return openPhoneStore(dataDir, { ...opts, guard: () => ++calls < 2 && opts.guard() })
  }
  const err = await releasePhone(dir, member, Buffer.from(key, 'hex'), { open: refuseWrite }).then(() => null, (e) => e)
  t.ok(err, 'the release fails')
  t.is(err.message, 'a gravação do phone.json falhou e pode ou não ter valido: confira com account phone --member <chave> antes de rodar de novo, sem consertar nem apagar o arquivo')
  t.absent(err.message.includes(DIGITS))
  t.absent(err.message.includes(key))
  t.alike(fs.readFileSync(file), before, 'the old file is intact')
  t.absent(fs.existsSync(path.join(dir, '.account-lock')), 'the lock is released')

  const wrongKey = varanda(dir, ['account', 'phone', '--release', '--member', member], { VARANDA_PHONE_KEY: hexKey() })
  t.is(wrongKey.code, 1)
  t.is(wrongKey.stderr, 'erro: phone.json inválido\n')
  t.is(wrongKey.stdout, '')
  t.alike(fs.readFileSync(file), before, 'a wrong key writes nothing')
})
