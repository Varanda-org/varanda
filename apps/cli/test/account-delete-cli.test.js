'use strict'

// apps/cli/lib/commands/account.js: `account delete`, the operator's way to
// schedule Excluir conta for a member who cannot ask from the app (no
// passkey, no recovery code, no phone). It shows what the member can still
// sign in with and refuses while anything is left (unless --force), writes
// the same passkeys.json hold as the app's wait path (./delete-routes.js)
// under the service's lock, and queues the push notice in
// deletion-notices.json for the service's next start. The directory and the
// sidecars are seeded through their stores; keys are generated here and
// nothing reaches the network.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createIssuedCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { openAccountStore, COOLDOWN_MS } = require('../lib/account/store')
const { openPagesStore } = require('../lib/account/pages-store')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { openRecoveryStore } = require('../lib/account/recovery-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createDeleteRoutes, WAIT_MS } = require('../lib/account/delete-routes')
const { drainNotices } = require('../lib/account/deletion-notices')
const { takeLock } = require('../lib/account/server')
const { scheduleDeletion, scheduleLines, cancelDeletion } = require('../lib/commands/account')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const SIG = 'a'.repeat(128)
const RP = 'varanda.test'
const NOTHING = 'nada foi gravado; rode de novo com --yes'
const PAGE_OWNER = 'a conta é dona de uma página: ela precisa ser encerrada ou transferida antes'
const RESTORED = 'diretório de contas restaurado de uma cópia antiga; confira o backup'
const EVA_LEFT = 'a conta ainda tem 1 passkey guardada, 1 código de recuperação, 1 passkey extra de recuperação e celular confirmado: confira que a pessoa perdeu o acesso a eles e rode de novo com --force'
const NONE = { passkeys: 0, recoveryCodes: 0, recoveryPasskeys: 0, phone: false }
const EVA = { passkeys: 1, recoveryCodes: 1, recoveryPasskeys: 1, phone: true }
const ENV = {
  VARANDA_PUBLIC_ORIGIN: 'https://varanda.test',
  VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste'
}
const CBS = { linked: () => false, burnable: () => false, deleted: () => false }

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function varanda (dir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function memberHex () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function hex (n) {
  return nodeCrypto.randomBytes(n).toString('hex')
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { kp, cert, association: cert.association }
}

// Brasília 'dd/mm/aaaa', as apps/app/src/accountDeletion.js scheduleDate.
function brDate (iso) {
  const d = new Date(Date.parse(iso) - 3 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear()
}

function when (iso) {
  return brDate(iso) + ' (' + iso + ')'
}

function bytes (file) {
  try {
    return fs.readFileSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// The identity and sign-in lines both the preview and --yes print.
function idLines (member, username, email, f = NONE) {
  return [
    'membro: ' + member,
    '@nome: ' + username,
    email === '' ? 'sem e-mail no vínculo' : 'e-mail: ' + email,
    'passkeys guardadas: ' + f.passkeys,
    'códigos de recuperação: ' + f.recoveryCodes,
    'passkeys extras de recuperação: ' + f.recoveryPasskeys,
    'celular: ' + (f.phone ? 'confirmado' : 'sem registro')
  ]
}

// ana: Google-linked as 'ana', renamed to 'ana_nova' (her old name is past).
// bia: phone-linked, no e-mail. caio: deleted. dono: Google-linked, owns the
// live page 'padaria'. eva: Google-linked with a stored passkey, a recovery
// code, an extra passkey entry and a verified phone. stranger: never linked.
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
  const dono = memberHex()
  const eva = memberHex()
  const page = memberHex()
  for (const [member, username, email] of [[ana, 'ana', 'ana@example.test'], [caio, 'caio', 'caio@example.test'], [dono, 'dono', 'dono@example.test'], [eva, 'eva', 'eva@example.test']]) {
    const row = store.start({ member, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: 'sub-' + username, email })
    await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  }
  const phone = store.start({ member: bia, username: 'bia' })
  await store.finish(phone.id, { signature: SIG, phone: true }, iss.kp, iss.cert, iss.association)
  const date = new Date(c.t).toISOString()
  await store.reservePage({
    key: page,
    username: 'padaria',
    cert: createIssuedCert({ member: page, date }, iss.kp, iss.cert),
    usernameRecord: createUsernameRecord({ member: page, username: 'padaria', date }, iss.kp, iss.cert)
  })
  c.t += COOLDOWN_MS
  await store.rename(ana, 'ana_nova', iss.kp, iss.cert)
  await store.deleteMember(caio)
  await store.close()

  const pages = openPagesStore(dir)
  await pages.create({ page, owner: dono })

  const pk = createFakePasskey({ rpId: RP })
  const key = keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: RP })
  await openPasskeyStore(dir).add({ member: eva, credentialId: pk.credentialId, ...key })
  const recovery = openRecoveryStore(dir)
  await recovery.put({ member: eva, kind: 'code', lookupId: hex(32), blob: { v: 1, kind: 'code', nonce: hex(24), ciphertext: hex(82) } })
  await recovery.put({ member: eva, kind: 'passkey', lookupId: hex(32), blob: { v: 1, kind: 'passkey', nonce: hex(24), ciphertext: hex(82) } })
  await openPhoneStore(dir, { key: nodeCrypto.randomBytes(32) }).record({ member: eva, phone: '+5511987654321' }, CBS)
  const file = path.join(dir, 'passkeys.json')
  return { dir, file, keys0: bytes(file), notices: path.join(dir, 'deletion-notices.json'), ana, bia, caio, dono, eva, page, stranger: memberHex() }
}

function queued (s) {
  const raw = bytes(s.notices)
  return raw === null ? null : JSON.parse(raw.toString('utf8'))
}

test('account delete: the preview writes nothing and shows the e-mail, or that the link has none', async (t) => {
  const s = await seeded(t)
  const r = varanda(s.dir, ['account', 'delete', '--member', s.ana])
  t.is(r.code, 0, r.stderr)
  t.is(r.stderr, '')
  t.is(r.stdout, [...idLines(s.ana, 'ana_nova', 'ana@example.test'), 'nenhuma exclusão agendada', NOTHING].join('\n') + '\n')
  t.alike(bytes(s.file), s.keys0, 'passkeys.json unchanged')

  const phone = varanda(s.dir, ['account', 'delete', '--username', 'bia', '--json'])
  t.is(phone.code, 0, phone.stderr)
  t.alike(JSON.parse(phone.stdout), { member: s.bia, username: 'bia', email: '', ...NONE, scheduled: null, ownsLivePage: false, written: false })
  const text = varanda(s.dir, ['account', 'delete', '--username', 'bia'])
  t.ok(text.stdout.split('\n').includes('sem e-mail no vínculo'), text.stdout)

  const owner = varanda(s.dir, ['account', 'delete', '--member', s.dono])
  t.is(owner.code, 0, 'a live page still previews')
  t.ok(owner.stdout.split('\n').includes(PAGE_OWNER), owner.stdout)

  // With a hold on file: shown, and the file's bytes stay as they were.
  t.is(varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes']).code, 0)
  const before = bytes(s.file)
  const notices = bytes(s.notices)
  const hold = openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana)
  const lock = takeLock(s.dir)
  const held = varanda(s.dir, ['account', 'delete', '--member', s.ana])
  lock.release()
  t.is(held.code, 0, 'the preview runs while the service holds the lock: ' + held.stderr)
  t.ok(held.stdout.split('\n').includes('exclusão já agendada para ' + when(hold.runAt)), held.stdout)
  t.alike(bytes(s.file), before, 'passkeys.json unchanged')
  t.alike(bytes(s.notices), notices, 'deletion-notices.json unchanged')
})

test('account delete: the preview shows what the member can still sign in with', async (t) => {
  const s = await seeded(t)
  const passkeys = bytes(s.file)
  const r = varanda(s.dir, ['account', 'delete', '--member', s.eva])
  t.is(r.code, 0, r.stderr)
  t.is(r.stdout, [...idLines(s.eva, 'eva', 'eva@example.test', EVA), 'nenhuma exclusão agendada', NOTHING].join('\n') + '\n')
  const json = varanda(s.dir, ['account', 'delete', '--username', '@eva', '--json'])
  t.alike(JSON.parse(json.stdout), { member: s.eva, username: 'eva', email: 'eva@example.test', ...EVA, scheduled: null, ownsLivePage: false, written: false })
  t.alike(bytes(s.file), passkeys, 'passkeys.json unchanged')
  t.is(bytes(s.notices), null)
})

test('account delete --yes: writes the hold 7 days ahead and queues one notice; again keeps the first date', async (t) => {
  const s = await seeded(t)
  const from = Date.now()
  const r = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes'])
  const to = Date.now()
  t.is(r.code, 0, r.stderr)
  t.is(r.stderr, '')
  const hold = openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana)
  t.ok(hold, 'a hold is on file')
  const runAt = Date.parse(hold.runAt)
  t.ok(runAt >= from + WAIT_MS && runAt <= to + WAIT_MS, 'runAt is now + WAIT_MS')
  t.ok(Date.parse(hold.at) >= from && Date.parse(hold.at) <= to, 'at is the moment it was written')
  t.is(r.stdout, [...idLines(s.ana, 'ana_nova', 'ana@example.test'), 'exclusão agendada para ' + when(hold.runAt)].join('\n') + '\n')
  t.alike(queued(s), { v: 1, members: [s.ana] }, 'the notice is queued')
  t.absent(fs.existsSync(path.join(s.dir, '.account-lock')), 'the lock is released')

  const notices = bytes(s.notices)
  const again = varanda(s.dir, ['account', 'delete', '--username', '@ana_nova', '--yes'])
  t.is(again.code, 0, again.stderr)
  t.is(again.stdout, [...idLines(s.ana, 'ana_nova', 'ana@example.test'), 'exclusão já agendada para ' + when(hold.runAt)].join('\n') + '\n')
  t.alike(openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana), hold, 'the first date stays')
  t.alike(bytes(s.notices), notices, 'no second notice for an existing hold')

  const json = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes', '--json'])
  t.alike(JSON.parse(json.stdout), { member: s.ana, username: 'ana_nova', email: 'ana@example.test', ...NONE, scheduled: hold.runAt, already: true })

  // A member with no e-mail on file is the operator's call: allowed.
  const phone = varanda(s.dir, ['account', 'delete', '--member', s.bia, '--yes'])
  t.is(phone.code, 0, phone.stderr)
  const biaHold = openPasskeyStore(s.dir, { readOnly: true }).hold(s.bia)
  t.is(phone.stdout, [...idLines(s.bia, 'bia', ''), 'exclusão agendada para ' + when(biaHold.runAt)].join('\n') + '\n')
  t.alike(queued(s), { v: 1, members: [s.ana, s.bia] })
})

test('account delete --yes: the date is told in Brasília time', async (t) => {
  const s = await seeded(t)
  const now = () => Date.parse('2025-12-25T01:30:00.000Z')
  const out = await scheduleDeletion(s.dir, { member: s.ana, username: null }, { now })
  t.is(out.scheduled, '2026-01-01T01:30:00.000Z')
  t.ok(scheduleLines(out).split('\n').includes('exclusão agendada para 31/12/2025 (2026-01-01T01:30:00.000Z)'), scheduleLines(out))
})

test('account delete --yes: a member who can still sign in needs --force; nothing is written or queued without it', async (t) => {
  const s = await seeded(t)
  const passkeys = bytes(s.file)
  const r = varanda(s.dir, ['account', 'delete', '--member', s.eva, '--yes'])
  t.is(r.code, 1)
  t.is(r.stderr, 'erro: ' + EVA_LEFT + '\n')
  t.is(r.stdout, '')
  t.alike(bytes(s.file), passkeys, 'passkeys.json unchanged')
  t.is(bytes(s.notices), null, 'no notice queued')

  const forced = varanda(s.dir, ['account', 'delete', '--member', s.eva, '--yes', '--force'])
  t.is(forced.code, 0, forced.stderr)
  const hold = openPasskeyStore(s.dir, { readOnly: true }).hold(s.eva)
  t.ok(hold)
  t.is(forced.stdout, [...idLines(s.eva, 'eva', 'eva@example.test', EVA), 'exclusão agendada para ' + when(hold.runAt)].join('\n') + '\n')
  t.alike(queued(s), { v: 1, members: [s.eva] })

  const undo = varanda(s.dir, ['account', 'delete', '--member', s.eva, '--undo'])
  t.is(undo.code, 0, '--undo never needs --force: ' + undo.stderr)
  t.is(undo.stdout, 'exclusão cancelada\n')
})

test('account delete: a held service lock refuses --yes and --undo and writes nothing', async (t) => {
  const s = await seeded(t)
  const lock = takeLock(s.dir)
  const yes = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes'])
  const undo = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--undo'])
  t.ok(lock.owned(), 'the lock is untouched')
  lock.release()
  t.is(yes.code, 1)
  t.is(yes.stderr, 'erro: pare o serviço de conta antes de agendar uma exclusão\n')
  t.is(yes.stdout, '')
  t.is(undo.code, 1)
  t.is(undo.stderr, 'erro: pare o serviço de conta antes de cancelar uma exclusão\n')
  t.alike(bytes(s.file), s.keys0, 'nothing written')
  t.is(bytes(s.notices), null, 'nothing queued')
})

test('account delete: --username finds a member by any name, with or without @ and in any case; pages, unknown and deleted names are refused', async (t) => {
  const s = await seeded(t)
  for (const name of ['@ANA', 'Ana', '@Ana_Nova']) {
    const r = varanda(s.dir, ['account', 'delete', '--username', name, '--json'])
    t.is(r.code, 0, name + ': ' + r.stderr)
    const out = JSON.parse(r.stdout)
    t.is(out.member, s.ana, name)
    t.is(out.username, 'ana_nova', name + ': the current @nome')
  }
  for (const [name, message] of [['@padaria', 'o nome é de uma página'], ['ninguem', 'nome não encontrado'], ['@caio', 'conta já excluída']]) {
    for (const extra of [[], ['--yes']]) {
      const r = varanda(s.dir, ['account', 'delete', '--username', name, ...extra])
      t.is(r.code, 1, name + ' ' + extra)
      t.is(r.stderr, 'erro: ' + message + '\n', name + ' ' + extra)
      t.is(r.stdout, '')
    }
  }
  t.alike(bytes(s.file), s.keys0, 'nothing written')
})

test('account delete: an unlinked or deleted key and the owner of a live page are refused', async (t) => {
  const s = await seeded(t)
  for (const [member, message] of [[s.stranger, 'chave sem vínculo'], [s.page, 'chave sem vínculo'], [s.caio, 'conta já excluída']]) {
    for (const extra of [[], ['--yes'], ['--undo']]) {
      const r = varanda(s.dir, ['account', 'delete', '--member', member, ...extra])
      t.is(r.code, 1, message + ' ' + extra)
      t.is(r.stderr, 'erro: ' + message + '\n')
    }
  }
  const owner = varanda(s.dir, ['account', 'delete', '--member', s.dono, '--yes'])
  t.is(owner.code, 1)
  t.is(owner.stderr, 'erro: ' + PAGE_OWNER + '\n')
  t.alike(bytes(s.file), s.keys0, 'nothing written')
  t.is(bytes(s.notices), null, 'nothing queued')

  // A closed page no longer holds it.
  await openPagesStore(s.dir).close(s.page)
  const closed = varanda(s.dir, ['account', 'delete', '--member', s.dono, '--yes'])
  t.is(closed.code, 0, closed.stderr)
  t.ok(openPasskeyStore(s.dir, { readOnly: true }).hold(s.dono))
})

test('account delete --undo: cancels the hold and drops its notice; with nothing scheduled it still exits 0', async (t) => {
  const s = await seeded(t)
  const none = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--undo'])
  t.is(none.code, 0, none.stderr)
  t.is(none.stdout, 'nenhuma exclusão agendada\n')

  t.is(varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes']).code, 0)
  t.is(varanda(s.dir, ['account', 'delete', '--member', s.bia, '--yes']).code, 0)
  t.alike(queued(s), { v: 1, members: [s.ana, s.bia] })
  const undo = varanda(s.dir, ['account', 'delete', '--username', 'ana_nova', '--undo'])
  t.is(undo.code, 0, undo.stderr)
  t.is(undo.stdout, 'exclusão cancelada\n')
  t.is(openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana), null, 'no hold left')
  t.alike(queued(s), { v: 1, members: [s.bia] }, 'only her notice goes')
  const json = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--undo', '--json'])
  t.alike(JSON.parse(json.stdout), { member: s.ana, cancelled: false })
  t.is(varanda(s.dir, ['account', 'delete', '--member', s.bia, '--undo']).code, 0)
  t.is(bytes(s.notices), null, 'the last notice removes the file')
  t.absent(fs.existsSync(path.join(s.dir, '.account-lock')), 'the lock is released')
})

test('account delete: neither or both of --member and --username, or --yes with --undo, is a usage error', async (t) => {
  const s = await seeded(t)
  for (const [args, message] of [
    [[], 'use --member ou --username'],
    [['--yes'], 'use --member ou --username'],
    [['--member', s.ana, '--username', 'ana_nova'], 'use --member ou --username'],
    [['--member', s.ana, '--yes', '--undo'], 'use --yes ou --undo']
  ]) {
    const r = varanda(s.dir, ['account', 'delete', ...args])
    t.is(r.code, 2, args.join(' '))
    t.ok(r.stderr.startsWith('uso: ' + message + '\n'), r.stderr)
    t.is(r.stdout, '')
  }
  t.alike(bytes(s.file), s.keys0, 'nothing written')
})

test('account delete: an invalid passkeys.json is refused and left as it is', async (t) => {
  const s = await seeded(t)
  fs.writeFileSync(s.file, '{"v":9}')
  const before = bytes(s.file)
  for (const extra of [[], ['--yes'], ['--undo']]) {
    const r = varanda(s.dir, ['account', 'delete', '--member', s.ana, ...extra])
    t.is(r.code, 1, 'exit 1 ' + extra)
    t.is(r.stderr, 'erro: passkeys.json inválido\n')
    t.is(r.stdout, '')
  }
  t.alike(bytes(s.file), before, 'the file is untouched')
  t.is(bytes(s.notices), null)
})

test('account delete: an invalid pages.json or deletion-notices.json is refused before anything is written', async (t) => {
  const s = await seeded(t)
  const pagesFile = path.join(s.dir, 'pages.json')
  const pages = bytes(pagesFile)
  fs.writeFileSync(pagesFile, '{')
  for (const extra of [[], ['--yes']]) {
    const r = varanda(s.dir, ['account', 'delete', '--member', s.ana, ...extra])
    t.is(r.code, 1, 'pages ' + extra)
    t.is(r.stderr, 'erro: pages.json inválido\n')
  }
  t.alike(bytes(s.file), s.keys0, 'passkeys.json unchanged')
  fs.writeFileSync(pagesFile, pages)

  fs.writeFileSync(s.notices, '{"v":1,"members":["x"]}')
  const notices = bytes(s.notices)
  const r = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes'])
  t.is(r.code, 1)
  t.is(r.stderr, 'erro: deletion-notices.json inválido\n')
  t.alike(bytes(s.file), s.keys0, 'no hold without a place for its notice')
  t.alike(bytes(s.notices), notices, 'left as it is')
})

test('account delete: a directory restored from an old copy refuses --yes and --undo; the preview only warns', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  t.is(varanda(dir, ['account', 'key', '--association', iss.association]).code, 0)
  const ana = memberHex()
  const link = async (member, username) => {
    const store = openAccountStore(dir)
    const row = store.start({ member, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: 'sub-' + username, email: username + '@example.test' })
    await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
    await store.close()
  }
  await link(ana, 'ana')
  const old = bytes(path.join(dir, 'directory.json'))
  await link(memberHex(), 'bia')
  fs.writeFileSync(path.join(dir, 'directory.json'), old)

  for (const extra of [['--yes'], ['--undo']]) {
    const r = varanda(dir, ['account', 'delete', '--member', ana, ...extra])
    t.is(r.code, 1, extra[0])
    t.is(r.stderr, 'erro: ' + RESTORED + '\n')
  }
  t.is(bytes(path.join(dir, 'passkeys.json')), null, 'nothing written')
  const preview = varanda(dir, ['account', 'delete', '--member', ana])
  t.is(preview.code, 0, preview.stderr)
  t.is(preview.stderr, 'aviso: ' + RESTORED + '\n')
})

test('account delete: a write refused before the rename is not retried; one refused after it is reported and has landed', async (t) => {
  const s = await seeded(t)
  const message = 'não foi possível confirmar a gravação: confira com account delete --member ' + s.ana
  // The passkey store asks its guard before the re-read (1), right before
  // the rename (2) and after it (3).
  const refuseAt = (n) => (dataDir, opts) => {
    let calls = 0
    return openPasskeyStore(dataDir, { ...opts, guard: () => ++calls !== n && opts.guard() })
  }
  const by = { member: s.ana, username: null }

  const before = await scheduleDeletion(s.dir, by, { open: refuseAt(2) }).then(() => ({ message: 'no error' }), (e) => e)
  t.is(before.message, message + ', e o aviso push entrou na fila')
  t.alike(bytes(s.file), s.keys0, 'nothing landed: no second attempt')
  t.absent(fs.existsSync(path.join(s.dir, '.account-lock')), 'the lock is released')

  const after = await scheduleDeletion(s.dir, by, { open: refuseAt(3) }).then(() => ({ message: 'no error' }), (e) => e)
  t.is(after.message, message + ', e o aviso push entrou na fila')
  const hold = openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana)
  t.ok(hold, 'the hold landed')
  t.alike(queued(s), { v: 1, members: [s.ana] }, 'its notice is queued too')
  const again = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes'])
  t.is(again.code, 0, again.stderr)
  t.ok(again.stdout.endsWith('exclusão já agendada para ' + when(hold.runAt) + '\n'), again.stdout)

  const undoBefore = await cancelDeletion(s.dir, by, { open: refuseAt(2) }).then(() => ({ message: 'no error' }), (e) => e)
  t.is(undoBefore.message, message)
  t.alike(openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana), hold, 'the hold stays: no second attempt')
  const undoAfter = await cancelDeletion(s.dir, by, { open: refuseAt(3) }).then(() => ({ message: 'no error' }), (e) => e)
  t.is(undoAfter.message, message)
  t.is(openPasskeyStore(s.dir, { readOnly: true }).hold(s.ana), null, 'the cancel landed')
  const undoAgain = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--undo'])
  t.is(undoAgain.stdout, 'nenhuma exclusão agendada\n')
})

test('account delete --yes: a hold already on file with no notice queued gets it queued', async (t) => {
  const s = await seeded(t)
  const { runAt } = await openPasskeyStore(s.dir).schedule({ member: s.ana, runAt: new Date(Date.now() + WAIT_MS).toISOString() })
  t.is(bytes(s.notices), null, 'no notice before')
  const r = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes'])
  t.is(r.code, 0, r.stderr)
  t.ok(r.stdout.endsWith('exclusão já agendada para ' + when(runAt) + '\n'), r.stdout)
  t.alike(queued(s), { v: 1, members: [s.ana] }, 'the rerun repairs the queue')
})

test('account delete --yes: the service sweep runs the deletion at the date', async (t) => {
  const s = await seeded(t)
  const r = varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes'])
  t.is(r.code, 0, r.stderr)

  const clock = { t: Date.now() }
  const now = () => clock.t
  const accounts = openAccountStore(s.dir, { now })
  const passkeys = openPasskeyStore(s.dir, { now })
  const deletions = []
  const refuse = (token) => Object.assign(new Error(token), { token })
  const routes = createDeleteRoutes({
    accounts,
    moderation: { requestDeletion: async (k) => { deletions.push(k) } },
    pagesStore: openPagesStore(s.dir, { now }),
    passkeys,
    now,
    rpId: RP,
    origins: ['https://varanda.test'],
    association: 'a'.repeat(64),
    memberLimit: () => true,
    send: () => {},
    refuse,
    fromStore: (err) => refuse(err.code || 'indisponivel'),
    checkPost: () => {},
    readJsonBody: async () => ({}),
    over: () => refuse('over')
  })
  t.alike(await routes.runScheduled(), { ran: 0, skipped: 0 }, 'nothing before the date')
  t.is(accounts.status(s.ana).linked, true)
  clock.t += WAIT_MS + 1000
  t.alike(await routes.runScheduled(), { ran: 1, skipped: 0 })
  t.alike(deletions, [s.ana], 'the owner block is queued')
  t.is(accounts.status(s.ana).linked, false, 'the link is gone')
  t.ok(accounts.deletedAt(s.ana))
  t.is(accounts.status(s.dono).linked, true, 'nobody else')
  await accounts.close()
})

test('drainNotices: each queued member is offered once and the file goes; an invalid file is logged and removed', async (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'deletion-notices.json')
  const a = memberHex()
  const b = memberHex()
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: [a, b] }))
  const offered = []
  const logs = []
  const out = drainNotices(dir, { notify: (m) => { offered.push(m); return m === a ? 'sent' : 'skip' }, guard: () => true, log: (e) => logs.push(e) })
  t.alike(offered, [a, b])
  t.alike(out, { sent: 1, skipped: 1, kept: 0 })
  t.is(bytes(file), null, 'removed')
  t.alike(logs, [{ event: 'exclusao', reason: 'avisos-operador', sent: 1, skipped: 1, kept: 0 }], 'no key in the log')
  t.alike(drainNotices(dir, { notify: () => { throw new Error('none') }, guard: () => true }), { sent: 0, skipped: 0, kept: 0 }, 'no file: nothing offered')

  // A member the stores could not answer for (or a throw) stays queued.
  const c = memberHex()
  const d = memberHex()
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: [a, c, b, d] }))
  const answers = { [a]: 'sent', [b]: 'skip', [c]: 'keep' }
  const mixed = drainNotices(dir, { notify: (m) => { if (m === d) throw new Error('store'); return answers[m] }, guard: () => true })
  t.alike(mixed, { sent: 1, skipped: 1, kept: 2 })
  t.alike(JSON.parse(bytes(file)), { v: 1, members: [c, d] }, 'only the kept members stay')
  const whole = bytes(file)
  t.alike(drainNotices(dir, { notify: () => 'keep', guard: () => true }), { sent: 0, skipped: 0, kept: 2 })
  t.alike(bytes(file), whole, 'all kept: the file is left whole')

  fs.writeFileSync(file, '{"v":1,"members":[1]}')
  const bad = []
  t.alike(drainNotices(dir, { notify: () => { throw new Error('never') }, guard: () => true, log: (e) => bad.push(e) }), { sent: 0, skipped: 0, kept: 0 })
  t.alike(bad, [{ event: 'exclusao', reason: 'avisos-invalidos' }])
  t.is(bytes(file), null, 'an invalid file is removed, so the next start does not refuse it again')

  fs.writeFileSync(file, JSON.stringify({ v: 1, members: [a] }))
  drainNotices(dir, { notify: () => 'sent', guard: () => false })
  t.ok(bytes(file), 'without the lock the file stays')
})

// Spawns `account` on a free port until 'ready', -> { events(), stop() }.
async function serve (t, dir) {
  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], { env: { ...cleanEnv, ...ENV } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  t.teardown(() => { child.kill('SIGKILL') }, { force: true })
  const events = () => stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const end = Date.now() + 30000
  while (Date.now() < end && !events().some((e) => e.event === 'ready') && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20))
  t.ok(events().some((e) => e.event === 'ready'), 'ready: ' + stderr)
  return {
    events,
    stdout: () => stdout,
    stop: async () => {
      child.kill('SIGTERM')
      return exited
    }
  }
}

test('account delete --yes: the service pushes the queued notice at its next start, only while the hold is there', async (t) => {
  const s = await seeded(t)
  t.is(varanda(s.dir, ['account', 'delete', '--member', s.ana, '--yes']).code, 0)
  // bia queued without a hold, caio deleted with a hold left behind: neither
  // is pushed.
  await openPasskeyStore(s.dir).schedule({ member: s.caio, runAt: new Date(Date.now() + WAIT_MS).toISOString() })
  fs.writeFileSync(s.notices, JSON.stringify({ v: 1, members: [s.ana, s.bia, s.caio] }))
  const first = await serve(t, s.dir)
  t.alike(first.events().filter((e) => e.event === 'exclusao' && /^avisos/.test(e.reason)), [{ event: 'exclusao', reason: 'avisos-operador', sent: 1, skipped: 2, kept: 0 }])
  t.is(bytes(s.notices), null, 'the file is removed')
  for (const m of [s.ana, s.bia, s.caio]) t.absent(first.stdout().includes(m), 'no key logged')
  t.is(await first.stop(), 0)

  const second = await serve(t, s.dir)
  t.alike(second.events().filter((e) => e.event === 'exclusao' && /^avisos/.test(e.reason)), [], 'nothing again at the next start')
  t.is(await second.stop(), 0)

  fs.writeFileSync(s.notices, 'not json')
  const third = await serve(t, s.dir)
  t.alike(third.events().filter((e) => e.event === 'exclusao' && /^avisos/.test(e.reason)), [{ event: 'exclusao', reason: 'avisos-invalidos' }], 'an invalid file does not stop the start')
  t.is(bytes(s.notices), null)
  t.is(await third.stop(), 0)

  // passkeys.json unreadable: whether ana still has a hold cannot be told,
  // so her notice waits for the next start.
  fs.writeFileSync(s.notices, JSON.stringify({ v: 1, members: [s.ana] }))
  fs.writeFileSync(s.file, '{"v":9}')
  const fourth = await serve(t, s.dir)
  t.alike(fourth.events().filter((e) => e.event === 'exclusao' && /^avisos/.test(e.reason)), [{ event: 'exclusao', reason: 'avisos-operador', sent: 0, skipped: 0, kept: 1 }])
  t.alike(queued(s), { v: 1, members: [s.ana] }, 'the member stays queued')
  t.is(await fourth.stop(), 0)
})
