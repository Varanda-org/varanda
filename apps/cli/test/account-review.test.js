'use strict'

// `account review` (apps/cli/lib/commands/account.js) and
// apps/cli/lib/account/review-account.js: the association's review account
// made with no device. The code it prints restores the same diary key the
// way the app does (lookup id, blob, root, key), the link carries a genuine
// 'finish' proof, the band is the association's and the phone gate lets the
// key through. Keys are generated here and nothing reaches the network: the
// service spawned here never calls the provider.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { verifyAccountLink } = require('@varanda/core/lib/account-link')
const { signPhone } = require('@varanda/core/lib/phone')
const { keyPairFromPrf } = require('@varanda/web-member/lib/passkey')
const { decodeCode, deriveRecoveryKeys, openRoot } = require('@varanda/web-member/lib/recovery')
const { openAccountStore, phoneSub } = require('../lib/account/store')
const { openAgeStore } = require('../lib/account/age-store')
const { openRecoveryStore } = require('../lib/account/recovery-store')
const { createReviewAccount, isReviewAccount, REVIEW_MAX } = require('../lib/account/review-account')
const { takeLock } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const CODE_RE = /^([0-9a-z]{4}-){8}[0-9a-z]{4}$/
const ENV = {
  VARANDA_PUBLIC_ORIGIN: 'https://varanda.test',
  VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste',
  VARANDA_DIDIT_API_KEY: 'didit-key-review-0123456789',
  VARANDA_DIDIT_WORKFLOW_ID: '11111111-2222-4333-8444-555555555555'
}
const APP = { 'x-varanda-client': 'app', 'content-type': 'application/json' }

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function varanda (dir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

// A configured account dir: the issuer key and, unless `cert` is false, its
// certificate from a fresh association.
function accountDir (t, { cert = true } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const assocKp = crypto.keyPair()
  const association = b4a.toString(assocKp.publicKey, 'hex')
  const key = varanda(dir, ['account', 'key', '--association', association, '--json'])
  if (key.code !== 0) throw new Error(key.stderr)
  if (cert) {
    const certFile = path.join(tmpDir(t), 'issuer-cert.json')
    fs.writeFileSync(certFile, JSON.stringify(createIssuerCert({ issuer: JSON.parse(key.stdout).publicKey }, assocKp)))
    const added = varanda(dir, ['account', 'cert', 'add', '--cert-file', certFile])
    if (added.code !== 0) throw new Error(added.stderr)
  }
  return { dir, association }
}

// The app's recovery sign-in, offline: code -> lookup id -> stored blob ->
// root -> diary key pair.
async function restore (dir, code) {
  const secret = decodeCode(code)
  const { lookupId, wrapKey } = await deriveRecoveryKeys(secret, 'code')
  const found = openRecoveryStore(dir, { readOnly: true }).fetch(lookupId)
  if (found === null) return null
  const opened = openRoot(found.blob, wrapKey, { member: found.member })
  if (opened === null) return null
  const kp = await keyPairFromPrf(opened.root)
  return { lookupId, found, kp, member: b4a.toString(kp.publicKey, 'hex') }
}

// Writable stores in a fresh dir and an in-memory issuer, for the module.
function stores (t) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  return {
    dir,
    iss,
    accounts: openAccountStore(dir),
    ages: openAgeStore(dir),
    recovery: openRecoveryStore(dir)
  }
}

function make (s, username, extra = {}) {
  return createReviewAccount({ username, association: s.iss.association, issuer: { keyPair: s.iss.keyPair, cert: s.iss.cert }, accounts: s.accounts, ages: s.ages, recovery: s.recovery, ...extra })
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

test('account review: links the name with the association band and prints a code that restores the same key', async (t) => {
  const { dir, association } = accountDir(t)
  const r = varanda(dir, ['account', 'review', '--username', '@Revisao', '--json'])
  t.is(r.code, 0, r.stderr)
  t.is(r.stderr, '')
  const out = JSON.parse(r.stdout)
  t.alike(Object.keys(out).sort(), ['code', 'member', 'username'])
  t.is(out.username, 'revisao', "'@' dropped and lowercased")
  t.ok(CODE_RE.test(out.code), 'a recovery code in the app format')

  const accounts = openAccountStore(dir, { readOnly: true })
  const st = accounts.status(out.member)
  t.ok(st.linked, 'linked')
  t.is(st.username, 'revisao')
  t.is(st.cert.member, out.member, 'a member certificate for the key')

  const band = openAgeStore(dir, { readOnly: true }).get(out.member)
  t.is(band.band, '18+')
  t.is(band.method, 'associacao', "the association's band, never 'didit'")

  const back = await restore(dir, out.code)
  t.ok(back !== null, 'the code finds and opens its entry')
  t.is(back.found.kind, 'code')
  t.is(back.member, out.member, 'the code restores the same diary key')
  t.is(back.found.member, out.member)
  t.is(st.cert.association, association)

  t.ok(fs.existsSync(path.join(dir, 'recovery.json')))
  for (const file of fs.readdirSync(dir)) {
    t.absent(fs.readFileSync(path.join(dir, file)).toString('utf8').includes(out.code), 'the code is in no file: ' + file)
  }
})

test('account review: plain output names the account, the key and the code once', async (t) => {
  const { dir } = accountDir(t)
  const r = varanda(dir, ['account', 'review', '--username', 'revisao'])
  t.is(r.code, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  t.is(lines.length, 3)
  t.is(lines[0], 'conta de revisão @revisao')
  t.ok(/^chave: [0-9a-f]{64}$/.test(lines[1]), lines[1])
  const code = lines[2].slice('código de recuperação (aparece só agora): '.length)
  t.ok(lines[2].startsWith('código de recuperação (aparece só agora): ') && CODE_RE.test(code), lines[2])
  t.is((await restore(dir, code)).member, lines[1].slice('chave: '.length))
})

test('account review: refuses while the service runs, without an issuer and with a bad name, writing nothing', async (t) => {
  const { dir } = accountDir(t)
  const lock = takeLock(dir)
  const held = varanda(dir, ['account', 'review', '--username', 'revisao'])
  lock.release()
  t.is(held.code, 1)
  t.is(held.stderr, 'erro: pare o serviço de conta antes de criar uma conta de revisão\n')
  t.absent(fs.existsSync(path.join(dir, 'age.json')), 'no band')
  t.absent(fs.existsSync(path.join(dir, 'recovery.json')), 'no code')

  const bare = accountDir(t, { cert: false })
  const noCert = varanda(bare.dir, ['account', 'review', '--username', 'revisao'])
  t.is(noCert.code, 1)
  t.is(noCert.stderr, 'erro: emissor sem chave ou sem certificado: rode account key e account cert add\n')

  const bad = varanda(dir, ['account', 'review', '--username', 'ab'])
  t.is(bad.code, 1)
  t.ok(bad.stderr.startsWith('erro: nome inválido'), bad.stderr)
  t.absent(fs.existsSync(path.join(dir, 'age.json')), 'still no band')

  for (const extra of [[], ['--member', 'a'.repeat(64)]]) {
    const usage = varanda(dir, ['account', 'review', ...extra])
    t.not(usage.code, 0)
    t.ok(usage.stderr.startsWith('uso: informe só --username <nome>\n'), usage.stderr)
  }
})

test('review account: a taken name is refused before any band is written', async (t) => {
  const s = stores(t)
  const first = await make(s, 'revisao')
  const before = fs.readFileSync(path.join(s.dir, 'age.json'), 'utf8')
  await t.exception(make(s, 'revisao'), /^Error: nome em uso$/)
  t.is(fs.readFileSync(path.join(s.dir, 'age.json'), 'utf8'), before, 'age.json unchanged')
  t.is(s.recovery.list(first.member).length, 1, 'one code for the first account')
})

test('review account: the link carries a genuine finish proof by the new key, for a phone subject', async (t) => {
  const s = stores(t)
  let seen = null
  const finish = s.accounts.finish
  s.accounts.finish = (id, opts, ...rest) => {
    seen = opts
    return finish(id, opts, ...rest)
  }
  let nonce = null
  const start = s.accounts.start
  s.accounts.start = (args) => {
    const row = start(args)
    nonce = row.nonce
    return row
  }
  const out = await make(s, 'revisao')
  t.is(seen.phone, true, 'the phone link path: no Google subject, no e-mail')
  t.ok(verifyAccountLink({ phase: 'finish', nonce, member: out.member, username: 'revisao', association: s.iss.association, sub: phoneSub(out.member) }, seen.signature).ok)
  t.ok(isReviewAccount(s.ages, out.member))
})

test('review account: at most REVIEW_MAX live ones; a deleted one frees its place', async (t) => {
  const s = stores(t)
  const made = []
  for (let i = 0; i < REVIEW_MAX; i++) made.push(await make(s, 'revisao' + i))
  await t.exception(make(s, 'revisao9'), /já existem 4 contas de revisão/)
  // A Didit band never counts.
  await s.ages.record({ member: b4a.toString(crypto.keyPair().publicKey, 'hex'), band: '18+', method: 'didit' })
  await s.accounts.deleteMember(made[0].member)
  const fifth = await make(s, 'revisao9')
  t.ok(s.accounts.status(fifth.member).linked)
})

test('review account: a definite link refusal forgets the band, an unsure one keeps it and names the key', async (t) => {
  const s = stores(t)
  const finish = s.accounts.finish
  const refuse = (code) => {
    s.accounts.finish = async () => {
      const err = new Error(code)
      err.code = code
      throw err
    }
  }
  refuse('nome-em-uso')
  await t.exception(make(s, 'revisao'), /^Error: nome em uso$/)
  t.alike(s.ages.entries(), [], 'band forgotten')

  refuse('indisponivel')
  let message = ''
  try {
    await make(s, 'revisao')
  } catch (err) {
    message = err.message
  }
  const kept = s.ages.entries()
  t.is(kept.length, 1, 'band kept: the link may have landed')
  t.is(message, 'não foi possível confirmar o vínculo da chave ' + kept[0].member + ': confira com account status antes de rodar de novo')
  s.accounts.finish = finish
})

test('review account: a code write that fails names the key to delete', async (t) => {
  const s = stores(t)
  s.recovery.put = async () => { throw new Error('disco') }
  let message = ''
  try {
    await make(s, 'revisao')
  } catch (err) {
    message = err.message
  }
  const [{ member }] = s.ages.entries()
  t.ok(s.accounts.status(member).linked)
  t.is(message, 'a conta @revisao foi criada sem código de recuperação: exclua com account delete --member ' + member + ' --yes --force e crie outra')
})

test('isReviewAccount: only the association band, never throws', async (t) => {
  const s = stores(t)
  const didit = b4a.toString(crypto.keyPair().publicKey, 'hex')
  await s.ages.record({ member: didit, band: '18+', method: 'didit' })
  t.absent(isReviewAccount(s.ages, didit))
  t.absent(isReviewAccount(s.ages, 'x'))
  t.absent(isReviewAccount(null, didit))
  t.absent(isReviewAccount({ get () { throw new Error('indisponivel') } }, didit))
})

test('serve: the recovery route hands the code entry to the app, and the restored key passes the phone gate', async (t) => {
  t.timeout(90000)
  const { dir, association } = accountDir(t)
  const made = varanda(dir, ['account', 'review', '--username', 'revisao', '--json'])
  t.is(made.code, 0, made.stderr)
  const { member, code } = JSON.parse(made.stdout)

  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], {
    env: { ...cleanEnv, ...ENV, VARANDA_PHONE_KEY: nodeCrypto.randomBytes(32).toString('hex') }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('close', resolve))
  t.teardown(() => { child.kill('SIGKILL') }, { force: true })
  const events = () => stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  t.ok(await until(() => events().find((e) => e.event === 'ready')), 'ready: ' + stderr)
  const base = 'http://127.0.0.1:' + events().find((e) => e.event === 'listening').port
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: APP, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }

  const st = await (await fetch(base + '/account/status?member=' + member)).json()
  t.is(st.linked, true)
  t.is(st.username, 'revisao')

  const secret = decodeCode(code)
  const { lookupId, wrapKey } = await deriveRecoveryKeys(secret, 'code')
  const fetched = await post('/account/recovery/fetch', { lookupId })
  t.is(fetched.status, 200)
  t.is(fetched.body.member, member)
  t.is(fetched.body.kind, 'code')
  const opened = openRoot(fetched.body.blob, wrapKey, { member })
  const kp = await keyPairFromPrf(opened.root)
  t.is(b4a.toString(kp.publicKey, 'hex'), member, 'the blob the service serves opens to the same key')

  const started = await post('/account/phone/start', { member })
  t.is(started.status, 200)
  const nonce = started.body.nonce
  const phone = await post('/account/phone/status', { member, nonce, signature: signPhone({ action: 'status', nonce, member, association }, kp) })
  t.is(phone.status, 200)
  t.alike(phone.body, { state: 'verificado' }, 'verificado with no number and no proof')

  t.absent(stdout.includes(code) || stderr.includes(code), 'the code never reaches the log')
  child.kill('SIGTERM')
  await exited
})
