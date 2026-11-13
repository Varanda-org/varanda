'use strict'

// apps/cli/lib/commands/account.js: `account phone --username <nome>`, the
// operator's lookup by name (current, past, deleted member and page). The
// directory, pages.json and phone.json are seeded through their stores, not
// the server; keys are generated here and nothing reaches the network.

const test = require('brittle')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createIssuedCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { openAccountStore, COOLDOWN_MS } = require('../lib/account/store')
const { openPagesStore } = require('../lib/account/pages-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const SIG = 'a'.repeat(128)
const ANA_PHONE = '+5511987654321'
const BIA_PHONE = '+5521998765432'
const CBS = { linked: () => false, burnable: () => false, deleted: () => false }

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function varanda (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function memberHex () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { kp, cert, association: cert.association }
}

function lines (stdout) {
  const all = stdout.split('\n')
  return { rows: all.slice(0, -1).map((l) => JSON.parse(l)), tail: all[all.length - 1] }
}

// ana: phone-linked, then renamed to ana_nova (her old name is past).
// bia: phone-linked, then deleted. caio: Google-linked, no number.
// padaria: a page owned by ana. feira: a page with no pages.json row.
// quitanda: a page whose pages.json row is a move tombstone.
async function seeded (t) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const created = varanda(dir, ['account', 'key', '--association', iss.association])
  t.is(created.code, 0, created.stderr)

  const c = { t: Date.now() - COOLDOWN_MS - 3600000 }
  const store = openAccountStore(dir, { now: () => c.t })
  const ana = memberHex()
  const bia = memberHex()
  const caio = memberHex()
  const page = memberHex()
  const unlisted = memberHex()
  const moved = memberHex()
  const movedTo = memberHex()
  for (const [member, username] of [[ana, 'ana'], [bia, 'bia']]) {
    const row = store.start({ member, username })
    await store.finish(row.id, { signature: SIG, phone: true }, iss.kp, iss.cert, iss.association)
  }
  const google = store.start({ member: caio, username: 'caio' })
  store.reserve(google.id)
  store.putGoogle(google.id, { sub: 'sub-caio', email: 'caio@example.test' })
  await store.finish(google.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  const date = new Date(c.t).toISOString()
  await store.reservePage({
    key: page,
    username: 'padaria',
    cert: createIssuedCert({ member: page, date }, iss.kp, iss.cert),
    usernameRecord: createUsernameRecord({ member: page, username: 'padaria', date }, iss.kp, iss.cert)
  })
  for (const [key, username] of [[unlisted, 'feira'], [moved, 'quitanda']]) {
    await store.reservePage({
      key,
      username,
      cert: createIssuedCert({ member: key, date }, iss.kp, iss.cert),
      usernameRecord: createUsernameRecord({ member: key, username, date }, iss.kp, iss.cert)
    })
  }
  c.t += COOLDOWN_MS
  await store.rename(ana, 'ana_nova', iss.kp, iss.cert)
  const del = await store.deleteMember(bia)
  await store.close()

  const pages = openPagesStore(dir)
  await pages.create({ page, owner: ana })
  // quitanda moved in pages.json while the directory still names the old key.
  await pages.create({ page: moved, owner: ana })
  await pages.move(moved, movedTo)

  const key = nodeCrypto.randomBytes(32).toString('hex')
  const phones = openPhoneStore(dir, { key: Buffer.from(key, 'hex') })
  await phones.record({ member: ana, phone: ANA_PHONE }, CBS)
  await phones.record({ member: bia, phone: BIA_PHONE }, CBS)
  return { dir, key, ana, bia, caio, page, moved, movedTo, deletedAt: del.at, issuerSecret: b4a.toString(iss.kp.secretKey, 'hex') }
}

function noSecret (t, s, r, label) {
  const out = r.stdout + r.stderr
  t.absent(out.includes(s.key), label + ': no phone key')
  t.absent(out.includes(s.issuerSecret), label + ': no issuer secret')
  t.absent(out.includes('"event"'), label + ': no log line')
}

test('account phone --username: a past name finds the member and the number, with or without @', async (t) => {
  const s = await seeded(t)
  for (const name of ['ana', '@ana', '@Ana']) {
    const r = varanda(s.dir, ['account', 'phone', '--username', name], { VARANDA_PHONE_KEY: s.key })
    t.is(r.code, 0, r.stderr)
    t.is(r.stderr, '')
    const { rows, tail } = lines(r.stdout)
    t.is(rows.length, 1, name + ': one line')
    t.is(tail, '')
    const out = rows[0]
    t.alike(Object.keys(out), ['username', 'key', 'kind', 'current', 'deletedAt', 'phone'])
    t.alike({ ...out, phone: null }, { username: 'ana', key: s.ana, kind: 'membro', current: false, deletedAt: null, phone: null }, name)
    t.is(out.phone.length, 1)
    t.is(out.phone[0].phone, ANA_PHONE)
    t.is(out.phone[0].end, null)
    noSecret(t, s, r, name)
  }
})

test('account phone --username: the current name and a member without a number', async (t) => {
  const s = await seeded(t)
  const r = varanda(s.dir, ['account', 'phone', '--username', 'ana_nova'], { VARANDA_PHONE_KEY: s.key })
  t.is(r.code, 0, r.stderr)
  const out = lines(r.stdout).rows[0]
  t.is(out.kind, 'membro')
  t.is(out.current, true)
  t.is(out.key, s.ana)
  t.is(out.phone[0].phone, ANA_PHONE)

  const google = varanda(s.dir, ['account', 'phone', '--username', 'caio'], { VARANDA_PHONE_KEY: s.key })
  t.is(google.code, 0, google.stderr)
  t.alike(lines(google.stdout).rows, [{ username: 'caio', key: s.caio, kind: 'membro', current: true, deletedAt: null, phone: [] }])
  noSecret(t, s, r, 'current')
})

test('account phone --username: a name released by a deletion finds the deleted member', async (t) => {
  const s = await seeded(t)
  const r = varanda(s.dir, ['account', 'phone', '--username', 'bia'], { VARANDA_PHONE_KEY: s.key })
  t.is(r.code, 0, r.stderr)
  const { rows } = lines(r.stdout)
  t.is(rows.length, 1)
  t.alike({ ...rows[0], phone: null }, { username: 'bia', key: s.bia, kind: 'excluido', current: false, deletedAt: s.deletedAt, phone: null })
  t.is(rows[0].phone[0].phone, BIA_PHONE)
  noSecret(t, s, r, 'deleted')
})

test('account phone --username: a page prints its owner and no number, without the phone key', async (t) => {
  const s = await seeded(t)
  for (const env of [{ VARANDA_PHONE_KEY: s.key }, {}]) {
    const r = varanda(s.dir, ['account', 'phone', '--username', 'padaria'], env)
    t.is(r.code, 0, r.stderr)
    t.alike(lines(r.stdout).rows, [{ username: 'padaria', key: s.page, kind: 'pagina', current: true, deletedAt: null, owner: s.ana }])
    t.absent(r.stdout.includes('987654321'), 'no number')
    noSecret(t, s, r, 'page')
  }
})

test('account phone --username: a page without a pages.json row fails, and a moved row shows movedTo', async (t) => {
  const s = await seeded(t)
  const unlisted = varanda(s.dir, ['account', 'phone', '--username', 'feira'], { VARANDA_PHONE_KEY: s.key })
  t.is(unlisted.code, 1)
  t.is(unlisted.stderr, 'erro: página sem registro em pages.json\n')
  t.is(unlisted.stdout, '')

  const moved = varanda(s.dir, ['account', 'phone', '--username', 'quitanda'], { VARANDA_PHONE_KEY: s.key })
  t.is(moved.code, 0, moved.stderr)
  t.alike(lines(moved.stdout).rows, [{ username: 'quitanda', key: s.moved, kind: 'pagina', current: true, deletedAt: null, owner: s.ana, movedTo: s.movedTo }])
  noSecret(t, s, moved, 'moved page')
})

test('account phone --username: refusals', async (t) => {
  const s = await seeded(t)
  const unknown = varanda(s.dir, ['account', 'phone', '--username', 'ninguem'], { VARANDA_PHONE_KEY: s.key })
  t.is(unknown.code, 1)
  t.is(unknown.stderr, 'erro: nome não encontrado\n')
  t.is(unknown.stdout, '')

  const noKey = varanda(s.dir, ['account', 'phone', '--username', 'ana'])
  t.is(noKey.code, 1)
  t.is(noKey.stderr, 'erro: VARANDA_PHONE_KEY ausente\n')
  t.is(noKey.stdout, '')

  const wrongKey = varanda(s.dir, ['account', 'phone', '--username', 'ana'], { VARANDA_PHONE_KEY: nodeCrypto.randomBytes(32).toString('hex') })
  t.is(wrongKey.code, 1)
  t.is(wrongKey.stderr, 'erro: phone.json inválido\n')

  for (const args of [[], ['--member', s.ana, '--username', 'ana'], ['--release', '--username', 'ana']]) {
    const r = varanda(s.dir, ['account', 'phone', ...args], { VARANDA_PHONE_KEY: s.key })
    t.is(r.code, 2, args.join(' ') + ': usage')
    t.is(r.stdout, '')
    t.ok(r.stderr.includes('use --member ou --username') || r.stderr.includes('informe --member <chave>'), r.stderr)
    t.absent(r.stderr.includes('987654321'), 'no number')
  }
})
