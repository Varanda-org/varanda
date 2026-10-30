'use strict'

// apps/cli/lib/account/wallet-store.js: the wallet.json sidecar where the
// account service keeps each member's payments account identifiers and
// wrapped wallet key. No network; the clock is injected and disk failures
// are simulated by wrapping fs functions.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openWalletStore, FILE, NETWORKS, KYC_STATUSES } = require('../lib/account/wallet-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-29T12:00:00.000Z')
const HOUR = 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()
const ADDR = '0x' + 'ab'.repeat(20)
const ADDR2 = '0x' + 'cd'.repeat(20)
const PSK = 'AoofiKHyVRLvdrknnXzoIh1Gd1YTwLaOBn4ibm103a4dpwHZA36dU9DiiZdDvQmNn+/='

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: T0, now: () => c.t }
  const open = (more = {}) => openWalletStore(dir, { now: c.now, ...opts, ...more })
  return { dir, file: path.join(dir, FILE), c, open, store: open() }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

async function typeErrors (t, fn, cases) {
  for (const args of cases) {
    try {
      await fn(args)
      t.fail('accepted ' + JSON.stringify(args))
    } catch (err) {
      t.ok(err instanceof TypeError, 'TypeError for ' + JSON.stringify(args))
    }
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function stubRename (t, fn) {
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = function (from, to) { return fn(renameSync, from, to) }
  return () => { fs.renameSync = renameSync }
}

function countRenames (t, file) {
  const n = { v: 0 }
  stubRename(t, (rename, from, to) => {
    if (to === file) n.v++
    return rename.call(fs, from, to)
  })
  return n
}

function entry (more = {}) {
  return {
    subAccountId: 'sub_1',
    subaccountUncertain: false,
    subaccountMarkAt: null,
    network: 'polygon',
    kyc: { status: 'nenhum', attempt: 1, attemptId: null, documentId: null, selfieId: null, updatedAt: iso(T0) },
    wallet: null,
    walletUncertain: false,
    walletMarkAt: null,
    createdAt: iso(T0),
    ...more
  }
}

async function approved (store, member, subAccountId = 'sub_1') {
  await store.create({ member, subAccountId, network: 'polygon' })
  await store.setKyc({ member, status: 'documentos', documentId: 'doc_1' })
  await store.setKyc({ member, status: 'pendente', attemptId: 'att_1' })
  await store.setKyc({ member, status: 'aprovado' })
}

test('constants', (t) => {
  t.is(FILE, 'wallet.json')
  t.alike([...NETWORKS], ['polygon', 'base'])
  t.alike([...KYC_STATUSES], ['nenhum', 'documentos', 'pendente', 'aprovado', 'recusado', 'expirado'])
  t.ok(Object.isFrozen(NETWORKS))
  t.ok(Object.isFrozen(KYC_STATUSES))
})

test('a missing file opens empty and writes nothing', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  t.ok(store.available())
  t.is(store.get(m), null)
  t.is(store.bySubAccount('sub_1'), null)
  t.alike(store.stats(), {
    members: 0,
    subaccounts: 0,
    subaccountUncertain: 0,
    wallets: 0,
    walletUncertain: 0,
    kyc: { nenhum: 0, documentos: 0, pendente: 0, aprovado: 0, recusado: 0, expirado: 0 }
  })
  t.is(await store.heal(), false)
  t.alike(fs.readdirSync(dir), [], 'nothing written')
  const missing = path.join(tmpDir(t), 'nope')
  t.is(openWalletStore(missing).get(m), null)
  t.absent(fs.existsSync(missing), 'open never creates the dir')
})

test('create, get and the exact file shape and mode', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  t.alike(await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' }), { changed: true })
  t.alike(store.get(m), entry())
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  const json = readFile(file)
  t.alike(json, { v: 1, members: { [m]: entry() } })
  t.alike(Object.keys(json.members[m]).sort(),
    ['createdAt', 'kyc', 'network', 'subAccountId', 'subaccountMarkAt', 'subaccountUncertain', 'wallet', 'walletMarkAt', 'walletUncertain'])
  const copy = store.get(m)
  copy.kyc.status = 'aprovado'
  copy.subAccountId = 'other'
  t.alike(store.get(m), entry(), 'get returns a copy')
})

test('a second create keeps the first subaccount and does not write', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  const renames = countRenames(t, file)
  c.t += HOUR
  t.alike(await store.create({ member: m, subAccountId: 'sub_2', network: 'base' }), { changed: false })
  t.alike(await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' }), { changed: false })
  t.is(renames.v, 0)
  t.is(store.get(m).subAccountId, 'sub_1')
  t.is(store.get(m).network, 'polygon')
})

test('setWallet twice keeps the first wallet; it clears the uncertain marker', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await approved(store, m)
  t.alike(await store.setWalletUncertain(m, true), { changed: true })
  t.ok(store.get(m).walletUncertain)
  c.t += HOUR
  t.alike(await store.setWallet({ member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK }), { changed: true })
  t.alike(store.get(m).wallet, { id: 'w_1', address: ADDR, protectedSymmetricKey: PSK, createdAt: iso(T0 + HOUR) })
  t.is(store.get(m).walletUncertain, false)
  c.t += HOUR
  t.alike(await store.setWallet({ member: m, id: 'w_2', address: ADDR2, protectedSymmetricKey: 'xyz' }), { changed: false })
  t.is(store.get(m).wallet.id, 'w_1')
  t.is(readFile(file).members[m].wallet.id, 'w_1')
  t.alike(await store.setWalletUncertain(m, true), { changed: false }, 'no marker once a wallet exists')
  t.is(store.get(m).walletUncertain, false)
})

test('setWallet and setKyc without a subaccount change nothing', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  t.alike(await store.setWallet({ member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK }), { changed: false })
  t.alike(await store.setKyc({ member: m, status: 'documentos' }), { changed: false })
  t.alike(await store.setWalletUncertain(m, true), { changed: false })
  t.alike(fs.readdirSync(dir), [])
  await store.intendSubaccount({ member: m, network: 'polygon' })
  t.alike(await store.setWallet({ member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK }), { changed: false })
  t.alike(await store.setWalletUncertain(m, true), { changed: false })
  t.is(store.get(m).wallet, null)
})

test('setKyc is monotonic and never downgrades aprovado', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  c.t += 1000
  t.alike(await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_1' }), { changed: true })
  t.alike(await store.setKyc({ member: m, status: 'documentos', selfieId: 'self_1' }), { changed: true })
  t.alike(await store.setKyc({ member: m, status: 'documentos', selfieId: 'self_1' }), { changed: false }, 'same values')
  c.t += 1000
  await store.setKyc({ member: m, status: 'pendente', attemptId: 'att_1' })
  t.alike(store.get(m).kyc, {
    status: 'pendente', attempt: 1, attemptId: 'att_1', documentId: 'doc_1', selfieId: 'self_1', updatedAt: iso(T0 + 2000)
  })
  t.alike(await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_2' }), { changed: false }, 'lower rank')
  t.is(store.get(m).kyc.documentId, 'doc_1')
  t.alike(await store.setKyc({ member: m, status: 'nenhum' }), { changed: false })
  c.t += 1000
  t.alike(await store.setKyc({ member: m, status: 'aprovado' }), { changed: true })
  for (const status of KYC_STATUSES) {
    t.alike(await store.setKyc({ member: m, status, attemptId: 'att_9' }), { changed: false }, 'aprovado stays: ' + status)
  }
  t.is(store.get(m).kyc.status, 'aprovado')
  t.is(store.get(m).kyc.attemptId, 'att_1')
})

test('C14: a new attempt after recusado or expirado increments and resets', async (t) => {
  const { store, open, c } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_1', selfieId: 'self_1' })
  await store.setKyc({ member: m, status: 'pendente', attemptId: 'att_1' })
  c.t += 1000
  await store.setKyc({ member: m, status: 'recusado' })
  t.alike(await store.setKyc({ member: m, status: 'pendente' }), { changed: false }, 'recusado outranks pendente')
  t.alike(await store.setKyc({ member: m, status: 'expirado' }), { changed: true }, 'recusado and expirado share a rank')
  c.t += 1000
  t.alike(await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_2' }), { changed: true })
  t.alike(store.get(m).kyc, {
    status: 'documentos', attempt: 2, attemptId: null, documentId: 'doc_2', selfieId: null, updatedAt: iso(T0 + 2000), previousAttemptIds: ['att_1']
  })
  t.alike(await store.setKyc({ member: m, status: 'recusado', attempt: 1 }), { changed: false }, 'old attempt ignored')
  t.alike(await store.setKyc({ member: m, status: 'pendente', attempt: 2, attemptId: 'att_2' }), { changed: true })
  t.is(open().get(m).kyc.attempt, 2, 'persisted')
})

test('C14: the merge prefers the higher attempt, then rank, then later updatedAt', async (t) => {
  const { open, file, c } = setup(t)
  const a = open()
  const m = memberKey()
  await a.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  await a.setKyc({ member: m, status: 'pendente', attemptId: 'att_1' })
  await a.setKyc({ member: m, status: 'recusado' })
  const b = open()
  await a.setKyc({ member: m, status: 'documentos' })
  // b still holds attempt 1 'recusado', which outranks 'documentos', yet the
  // newer attempt on disk wins.
  c.t += 1000
  t.alike(await b.setKyc({ member: m, status: 'recusado', attempt: 1 }), { changed: false })
  t.is(b.get(m).kyc.attempt, 2)
  t.is(b.get(m).kyc.status, 'documentos')
  t.is(readFile(file).members[m].kyc.attempt, 2)

  // Within one attempt the higher rank wins over a later update.
  const n = memberKey()
  await a.create({ member: n, subAccountId: 'sub_2', network: 'polygon' })
  const x = open()
  const y = open()
  await x.setKyc({ member: n, status: 'pendente' })
  c.t += 1000
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: { ...readFile(file).members, [n]: entry({ subAccountId: 'sub_2', kyc: { status: 'documentos', attempt: 1, attemptId: null, documentId: 'doc_y', selfieId: null, updatedAt: iso(c.t) } }) } }))
  t.is(await x.heal(), true, 'x writes back its higher rank')
  t.is(readFile(file).members[n].kyc.status, 'pendente')
  t.is(await y.heal(), false)
  t.is(y.get(n).kyc.status, 'pendente')
})

test('bad argument shapes throw TypeError', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  await typeErrors(t, (a) => store.create(a), [
    { member: 'zz', subAccountId: 'sub_1', network: 'polygon' },
    { member: m.toUpperCase(), subAccountId: 'sub_1', network: 'polygon' },
    { member: m, subAccountId: 'has space', network: 'polygon' },
    { member: m, subAccountId: 'x'.repeat(129), network: 'polygon' },
    { member: m, subAccountId: null, network: 'polygon' },
    { member: m, subAccountId: 'sub_1', network: 'ethereum' }
  ])
  await typeErrors(t, (a) => store.intendSubaccount(a), [
    { member: m, network: 'solana' },
    { member: 'x', network: 'polygon' }
  ])
  await typeErrors(t, (a) => store.setKyc(a), [
    { member: m, status: 'ok' },
    { member: m, status: 'pendente', attemptId: 5 },
    { member: m, status: 'pendente', documentId: 'a b' },
    { member: m, status: 'pendente', selfieId: {} },
    { member: m, status: 'pendente', attempt: 0 },
    { member: m, status: 'pendente', attempt: 1.5 }
  ])
  await typeErrors(t, (a) => store.setWallet(a), [
    { member: m, id: null, address: ADDR, protectedSymmetricKey: PSK },
    { member: m, id: 'w_1', address: ADDR.toUpperCase().replace('0X', '0x'), protectedSymmetricKey: PSK },
    { member: m, id: 'w_1', address: ADDR.slice(0, 41), protectedSymmetricKey: PSK },
    { member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: 'a'.repeat(8193) },
    { member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: 'tab\tkey' },
    { member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: 'caf\u00e9' },
    { member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: 'no spaces' },
    { member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: '' }
  ])
  await typeErrors(t, (v) => store.setWalletUncertain(m, v), ['yes', 1, null])
  await typeErrors(t, (mm) => store.setWalletUncertain(mm, true), ['nope'])
  await typeErrors(t, (mm) => store.clearSubaccountUncertain(mm), ['nope'])
  t.exception.all(() => store.get('nope'), TypeError)
  t.is(store.bySubAccount('a b'), null, 'a lookup by a non-id matches nobody')
  t.is(store.bySubAccount(5), null)
})

test('a malformed file answers indisponivel on every method and stays untouched', async (t) => {
  const m = memberKey()
  const m2 = memberKey()
  const wallet = { id: 'w_1', address: ADDR, protectedSymmetricKey: PSK, createdAt: iso(T0) }
  const cases = [
    { v: 1, members: {}, extra: true },
    { v: 2, members: {} },
    { v: 1, members: [] },
    { v: 1, members: { [m]: { ...entry(), walletPin: '123456' } } },
    { v: 1, members: { [m]: { ...entry(), cpf: '12345678909' } } },
    { v: 1, members: { [m]: entry({ wallet: { ...wallet, address: ADDR.toUpperCase().replace('0X', '0x') } }) } },
    { v: 1, members: { [m]: entry({ wallet: { ...wallet, pin: '123456' } }) } },
    { v: 1, members: { [m]: entry({ wallet: { ...wallet, id: null } }) } },
    { v: 1, members: { [m]: entry({ kyc: { ...entry().kyc, fullName: 'Fulana' } }) } },
    { v: 1, members: { [m]: entry({ kyc: { ...entry().kyc, status: 'ok' } }) } },
    { v: 1, members: { [m]: entry({ kyc: { ...entry().kyc, attempt: 0 } }) } },
    { v: 1, members: { [m]: entry({ network: 'ethereum' }) } },
    { v: 1, members: { [m]: entry({ subAccountId: 'sub_1', subaccountUncertain: true }) } },
    { v: 1, members: { [m]: entry({ wallet, walletUncertain: true }) } },
    { v: 1, members: { [m]: entry({ subAccountId: null, wallet }) } },
    { v: 1, members: { [m]: entry({ createdAt: '2026-10-29' }) } },
    { v: 1, members: { [m]: entry({ subAccountId: null, subaccountUncertain: true }) } },
    { v: 1, members: { [m]: entry({ walletUncertain: true }) } },
    { v: 1, members: { [m]: entry({ walletMarkAt: 'yesterday' }) } },
    { v: 1, members: { ABC: entry() } },
    { v: 1, members: { [m]: entry(), [m2]: entry() } },
    { v: 1, members: { [m]: entry({ wallet }), [m2]: entry({ subAccountId: 'sub_2', wallet }) } }
  ]
  const raws = [...cases.map((c) => JSON.stringify(c)), 'not json {']
  for (const raw of raws) {
    const { file, open } = setup(t)
    fs.writeFileSync(file, raw)
    const store = open()
    t.absent(store.available(), raw)
    await rejects(t, store.create({ member: m, subAccountId: 'sub_9', network: 'polygon' }), 'indisponivel', 'create')
    await rejects(t, store.intendSubaccount({ member: m, network: 'polygon' }), 'indisponivel', 'intend')
    await rejects(t, store.setKyc({ member: m, status: 'aprovado' }), 'indisponivel', 'setKyc')
    await rejects(t, store.setWalletUncertain(m, true), 'indisponivel', 'setWalletUncertain')
    await rejects(t, store.setWallet({ member: m, id: 'w', address: ADDR, protectedSymmetricKey: PSK }), 'indisponivel', 'setWallet')
    t.exception(() => store.get(m), /indisponivel/)
    t.exception(() => store.bySubAccount('sub_1'), /indisponivel/)
    t.exception(() => store.stats(), /indisponivel/)
    t.is(await store.heal(), false)
    t.is(fs.readFileSync(file, 'utf8'), raw, 'bytes unchanged')
  }
})

test('a malformed file appearing between writes answers indisponivel', async (t) => {
  const { store, file } = setup(t)
  await store.create({ member: memberKey(), subAccountId: 'sub_1', network: 'polygon' })
  fs.writeFileSync(file, 'garbage')
  await rejects(t, store.create({ member: memberKey(), subAccountId: 'sub_2', network: 'polygon' }), 'indisponivel', 'create')
  t.absent(store.available())
  t.is(fs.readFileSync(file, 'utf8'), 'garbage')
})

test('walletUncertain survives reopen', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  await approved(store, m)
  await store.setWalletUncertain(m, true)
  const again = open()
  t.is(again.get(m).walletUncertain, true)
  t.alike(await again.setWalletUncertain(m, false), { changed: true }, 'a readable answer clears it')
  t.is(open().get(m).walletUncertain, false)
})

test('C12: the subaccount intent is on disk before the create and is adopted later', async (t) => {
  const { store, open, file, c } = setup(t)
  const m = memberKey()
  t.alike(await store.intendSubaccount({ member: m, network: 'polygon' }), { changed: true })
  const marked = readFile(file).members[m]
  t.is(marked.subAccountId, null)
  t.is(marked.subaccountUncertain, true)
  t.is(store.bySubAccount('sub_1'), null)
  t.alike(await store.intendSubaccount({ member: m, network: 'polygon' }), { changed: false }, 'already marked')
  // Timeout: a restart still sees the member frozen.
  const again = open()
  t.is(again.get(m).subaccountUncertain, true)
  // A later read finds exactly one match and adopts it.
  c.t += HOUR
  t.alike(await again.create({ member: m, subAccountId: 'sub_1', network: 'polygon' }), { changed: true })
  t.alike(again.get(m), entry({ subaccountMarkAt: iso(T0 + HOUR) }), 'marker cleared, createdAt of the intent')
  t.is(again.bySubAccount('sub_1'), m)
  t.alike(await again.intendSubaccount({ member: m, network: 'polygon' }), { changed: false }, 'no marker once known')
  t.is(open().get(m).subaccountUncertain, false)
})

test('C12: a refusal clears the subaccount marker; nothing else does', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  await store.intendSubaccount({ member: m, network: 'base' })
  t.alike(await store.setKyc({ member: m, status: 'documentos' }), { changed: false }, 'no KYC without a subaccount')
  t.alike(await store.clearSubaccountUncertain(m), { changed: true })
  t.alike(await store.clearSubaccountUncertain(m), { changed: false })
  const e = open().get(m)
  t.is(e.subAccountId, null)
  t.is(e.subaccountUncertain, false)
  t.is(e.network, 'base')
  t.alike(await store.intendSubaccount({ member: m, network: 'polygon' }), { changed: true }, 'a new explicit opt in marks again')
  t.is(store.get(m).network, 'polygon')
})

test('C12: a marker on one holder survives the merge until the subaccount exists', async (t) => {
  const { open, file } = setup(t)
  const a = open()
  const b = open()
  const m = memberKey()
  await a.intendSubaccount({ member: m, network: 'polygon' })
  await b.create({ member: memberKey(), subAccountId: 'sub_other', network: 'polygon' })
  t.is(b.get(m).subaccountUncertain, true, 'b adopted the marker from disk')
  await b.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  t.is(await a.heal(), false)
  t.is(a.get(m).subAccountId, 'sub_1', 'a known subaccount beats the intent')
  t.is(a.get(m).subaccountUncertain, false)
  t.is(readFile(file).members[m].subaccountUncertain, false)
})

test('C12: a wallet marker stays until a wallet is stored', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  await approved(store, m)
  await store.setWalletUncertain(m, true)
  // A readable wallet/get without an address: the route leaves the marker, so
  // the member stays frozen across restarts.
  t.is(open().get(m).walletUncertain, true)
  t.is(open().get(m).wallet, null)
  const other = open()
  await other.setWallet({ member: m, id: 'w_found', address: ADDR, protectedSymmetricKey: PSK })
  t.is(await store.heal(), false)
  t.is(store.get(m).walletUncertain, false)
  t.is(store.get(m).wallet.id, 'w_found')
})

test('C13: the walletId is kept and is never null', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  await approved(store, m)
  await store.setWallet({ member: m, id: '6a4d263d4cc67674bf72a3c9', address: ADDR, protectedSymmetricKey: PSK })
  const w = open().get(m).wallet
  t.is(w.id, '6a4d263d4cc67674bf72a3c9')
  t.is(w.address, ADDR)
  t.is(w.protectedSymmetricKey, PSK)
  await typeErrors(t, (id) => store.setWallet({ member: memberKey(), id, address: ADDR, protectedSymmetricKey: PSK }), [null, undefined, ''])
})

test('two holders: the first wallet and the earlier subaccount win', async (t) => {
  const { open, file, c } = setup(t)
  const a = open()
  const b = open()
  const m = memberKey()
  await approved(a, m)
  // b never re-read: it still thinks there is no entry.
  c.t += HOUR
  t.alike(await b.create({ member: m, subAccountId: 'sub_late', network: 'base' }), { changed: false })
  t.is(b.get(m).subAccountId, 'sub_1')
  await a.setWallet({ member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK })
  c.t += HOUR
  t.alike(await b.setWallet({ member: m, id: 'w_2', address: ADDR2, protectedSymmetricKey: PSK }), { changed: false })
  t.is(readFile(file).members[m].wallet.id, 'w_1')
  t.is(b.get(m).kyc.status, 'aprovado')
  // An externally written earlier wallet wins the merge.
  const earlier = { id: 'w_0', address: ADDR2, protectedSymmetricKey: PSK, createdAt: iso(T0 - HOUR) }
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: { [m]: { ...readFile(file).members[m], wallet: earlier } } }))
  t.is(await a.heal(), false)
  t.is(a.get(m).wallet.id, 'w_0')
})

test('bySubAccount resolves a member created after open, here or on disk', async (t) => {
  const { store, open } = setup(t)
  const x = memberKey()
  const y = memberKey()
  t.is(store.bySubAccount('sub_x'), null)
  await store.create({ member: x, subAccountId: 'sub_x', network: 'polygon' })
  t.is(store.bySubAccount('sub_x'), x)
  await open().create({ member: y, subAccountId: 'sub_y', network: 'polygon' })
  t.is(store.bySubAccount('sub_y'), null, 'not yet re-read')
  await store.heal()
  t.is(store.bySubAccount('sub_y'), y)
  t.is(store.bySubAccount('sub_z'), null)
})

test('stats counts only', async (t) => {
  const { store } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const c = memberKey()
  await approved(store, a, 'sub_a')
  await store.setWallet({ member: a, id: 'w_a', address: ADDR, protectedSymmetricKey: PSK })
  await store.create({ member: b, subAccountId: 'sub_b', network: 'polygon' })
  await store.setWalletUncertain(b, true)
  await store.intendSubaccount({ member: c, network: 'polygon' })
  const s = store.stats()
  t.alike(s, {
    members: 3,
    subaccounts: 2,
    subaccountUncertain: 1,
    wallets: 1,
    walletUncertain: 1,
    kyc: { nenhum: 2, documentos: 0, pendente: 0, aprovado: 1, recusado: 0, expirado: 0 }
  })
  t.absent(JSON.stringify(s).includes('sub_'), 'no identifiers')
})

test('guard() false before the write refuses and writes nothing', async (t) => {
  let allow = false
  const { store, file } = setup(t, { guard: () => allow })
  const m = memberKey()
  await rejects(t, store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' }), 'indisponivel', 'refused')
  t.absent(fs.existsSync(file))
  t.is(store.get(m), null)
  t.ok(store.available(), 'one refusal does not wedge the store')
  allow = true
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  t.ok(store.get(m))
})

test('guard() false after the write leaves the store dirty and heal rewrites', async (t) => {
  let calls = 0
  let allowAfter = false
  const { store, file } = setup(t, { guard: () => ++calls < 2 || allowAfter })
  const m = memberKey()
  await rejects(t, store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' }), 'indisponivel', 'refused after write')
  t.is(store.get(m), null, 'not acknowledged in memory')
  allowAfter = true
  const renames = countRenames(t, file)
  t.is(await store.heal(), true, 'dirty: heal rewrites')
  t.is(renames.v, 1)
  t.is(store.get(m).subAccountId, 'sub_1', 'the landed entry is adopted on the re-read')
  t.is(await store.heal(), false)
})

test('readOnly never writes', async (t) => {
  const { store, file, open } = setup(t)
  const m = memberKey()
  const ro = open({ readOnly: true })
  await rejects(t, ro.create({ member: m, subAccountId: 'sub_1', network: 'polygon' }), 'indisponivel', 'readOnly')
  t.absent(fs.existsSync(file))
  t.is(await ro.heal(), false)
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  t.is(open({ readOnly: true }).get(m).subAccountId, 'sub_1', 'readOnly reads the file')
})

test('fail() refuses later calls', async (t) => {
  const { store } = setup(t)
  store.fail()
  t.absent(store.available())
  await rejects(t, store.create({ member: memberKey(), subAccountId: 'sub_1', network: 'polygon' }), 'indisponivel', 'after fail')
  t.is(await store.heal(), false)
})

test('a failed write rejects and memory stays as it was', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  stubRename(t, () => {
    throw Object.assign(new Error('simulado'), { code: 'EIO' })
  })
  await rejects(t, store.intendSubaccount({ member: m, network: 'polygon' }), 'indisponivel', 'write failed')
  t.is(store.get(m), null)
  t.ok(store.available())
  t.absent(fs.existsSync(file))
})

test('a write that lands but then throws is adopted only after a re-read', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await approved(store, m)
  let renames = 0
  let failNext = true
  stubRename(t, (rename, from, to) => {
    const out = rename.call(fs, from, to)
    if (to === file) {
      renames++
      if (failNext) {
        failNext = false
        throw Object.assign(new Error('simulado'), { code: 'EIO' })
      }
    }
    return out
  })
  await rejects(t, store.setWallet({ member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK }), 'indisponivel', 'fsync failed')
  t.is(store.get(m).wallet, null, 'unacknowledged write is not readable')
  const repeat = await store.setWallet({ member: m, id: 'w_2', address: ADDR2, protectedSymmetricKey: PSK })
  t.is(repeat.changed, false, 'the re-read found the landed wallet')
  t.is(renames, 2, 'dirty: rewritten before answering')
  t.is(store.get(m).wallet.id, 'w_1')
})

test('a failed write whose file cannot be reloaded marks the store unavailable', async (t) => {
  const { store, file } = setup(t)
  await store.create({ member: memberKey(), subAccountId: 'sub_1', network: 'polygon' })
  stubRename(t, (rename, from, to) => {
    if (to === file) {
      fs.unlinkSync(from)
      fs.writeFileSync(file, 'garbage')
      throw Object.assign(new Error('simulado'), { code: 'EIO' })
    }
    return rename.call(fs, from, to)
  })
  await rejects(t, store.create({ member: memberKey(), subAccountId: 'sub_2', network: 'polygon' }), 'indisponivel', 'write failed')
  t.absent(store.available())
})

test('heal() writes back an entry an external replacement dropped', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: {} }))
  t.is(await store.heal(), true)
  t.ok(readFile(file).members[m])
  t.is(await store.heal(), false, 'nothing left to do')
})

test('heal() satisfies the startHeal contract: resolves a boolean, never rejects', async (t) => {
  const { store } = setup(t)
  const p = store.heal()
  t.ok(p instanceof Promise)
  t.is(typeof await p, 'boolean')
  store.fail()
  t.is(await store.heal(), false)
})

test('concurrent calls serialize', async (t) => {
  const { store, file } = setup(t)
  const ms = [memberKey(), memberKey(), memberKey()]
  const outs = await Promise.all(ms.map((member, i) => store.create({ member, subAccountId: 'sub_' + i, network: 'polygon' })))
  t.alike(outs.map((o) => o.changed), [true, true, true])
  t.is(Object.keys(readFile(file).members).length, 3)
  const m = ms[0]
  const steps = await Promise.all([
    store.setKyc({ member: m, status: 'documentos', documentId: 'doc_1' }),
    store.setKyc({ member: m, status: 'documentos', selfieId: 'self_1' }),
    store.setKyc({ member: m, status: 'pendente', attemptId: 'att_1' })
  ])
  t.alike(steps.map((o) => o.changed), [true, true, true])
  t.alike(readFile(file).members[m].kyc, {
    status: 'pendente', attempt: 1, attemptId: 'att_1', documentId: 'doc_1', selfieId: 'self_1', updatedAt: iso(T0)
  })
})

test('the file never holds a PIN, CPF or name, whatever the caller passes', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon', pin: '135790', cpf: '12345678909' })
  await store.setKyc({ member: m, status: 'documentos', fullName: 'Fulana de Tal', taxIdNumber: '12345678909' })
  await store.setKyc({ member: m, status: 'pendente', attemptId: 'att_1' })
  await store.setKyc({ member: m, status: 'aprovado' })
  await store.setWallet({ member: m, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK, walletPin: '135790' })
  const raw = fs.readFileSync(file, 'utf8')
  for (const secret of ['135790', '12345678909', 'Fulana', 'pin', 'cpf', 'taxId', 'fullName']) {
    t.absent(raw.includes(secret), 'absent: ' + secret)
  }
})

test('a cleared subaccount marker is not brought back by a stale holder', async (t) => {
  const { open, file } = setup(t)
  const a = open()
  const m = memberKey()
  await a.intendSubaccount({ member: m, network: 'polygon' })
  const b = open()
  t.is(b.get(m).subaccountUncertain, true)
  // Same millisecond as the set: the clear is still the newer change.
  await a.clearSubaccountUncertain(m)
  t.is(await b.heal(), false, 'nothing to write back')
  t.is(b.get(m).subaccountUncertain, false)
  await b.create({ member: memberKey(), subAccountId: 'sub_other', network: 'polygon' })
  t.is(readFile(file).members[m].subaccountUncertain, false, 'a later write by the stale holder keeps the clear')
  // A newer set still beats an older clear.
  const stale = open()
  await a.intendSubaccount({ member: m, network: 'polygon' })
  t.is(await stale.heal(), false)
  t.is(stale.get(m).subaccountUncertain, true)
})

test('a cleared wallet marker is not brought back by a stale holder', async (t) => {
  const { open, file, c } = setup(t)
  const a = open()
  const m = memberKey()
  await approved(a, m)
  await a.setWalletUncertain(m, true)
  const b = open()
  c.t += 1000
  await a.setWalletUncertain(m, false)
  t.is(await b.heal(), false)
  t.is(b.get(m).walletUncertain, false)
  await b.create({ member: memberKey(), subAccountId: 'sub_other', network: 'polygon' })
  t.is(readFile(file).members[m].walletUncertain, false)
  t.is(open().get(m).walletUncertain, false)
})

test('two different known subaccounts for one member fail closed', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  c.t += HOUR
  const other = entry({
    subAccountId: 'sub_late',
    createdAt: iso(T0 + HOUR),
    kyc: { status: 'aprovado', attempt: 3, attemptId: 'att_x', documentId: 'doc_x', selfieId: 'self_x', updatedAt: iso(T0 + HOUR) },
    wallet: { id: 'w_x', address: ADDR, protectedSymmetricKey: PSK, createdAt: iso(T0 + HOUR) }
  })
  const raw = JSON.stringify({ v: 1, members: { [m]: other } })
  fs.writeFileSync(file, raw)
  t.is(await store.heal(), false)
  t.absent(store.available())
  t.exception(() => store.get(m), /indisponivel/)
  await rejects(t, store.create({ member: memberKey(), subAccountId: 'sub_9', network: 'polygon' }), 'indisponivel', 'create')
  t.is(fs.readFileSync(file, 'utf8'), raw, 'the other wallet and key stay on disk')

  // The same through a write instead of heal.
  const second = setup(t)
  await second.store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  fs.writeFileSync(second.file, raw)
  await rejects(t, second.store.setKyc({ member: m, status: 'documentos' }), 'indisponivel', 'setKyc')
  t.absent(second.store.available())
  t.is(fs.readFileSync(second.file, 'utf8'), raw)
})

test('a merge that would give one subaccount to two members fails closed', async (t) => {
  const { store, file } = setup(t)
  await store.create({ member: memberKey(), subAccountId: 'sub_1', network: 'polygon' })
  const raw = JSON.stringify({ v: 1, members: { [memberKey()]: entry() } })
  fs.writeFileSync(file, raw)
  t.is(await store.heal(), false)
  t.absent(store.available())
  t.is(fs.readFileSync(file, 'utf8'), raw)
})

test('KYC ids recorded by different writers in one attempt are all kept', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_1' })
  c.t += 1000
  const kyc = { status: 'pendente', attempt: 1, attemptId: 'att_1', documentId: null, selfieId: 'self_1', updatedAt: iso(c.t) }
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: { [m]: entry({ kyc }) } }))
  t.is(await store.heal(), true)
  t.alike(store.get(m).kyc, { ...kyc, documentId: 'doc_1' })
  t.alike(readFile(file).members[m].kyc, { ...kyc, documentId: 'doc_1' })
  // Both have one: the side whose status won keeps its id.
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: { [m]: entry({ kyc: { ...kyc, documentId: 'doc_9', status: 'recusado' } }) } }))
  t.is(await store.heal(), false, 'the disk already holds the merge')
  t.is(store.get(m).kyc.documentId, 'doc_9')
  t.is(store.get(m).kyc.status, 'recusado')
})

test('a subaccount or wallet held by another member is refused', async (t) => {
  const { store, file } = setup(t)
  const x = memberKey()
  const y = memberKey()
  await approved(store, x, 'sub_1')
  t.alike(await store.create({ member: y, subAccountId: 'sub_1', network: 'polygon' }), { changed: false, conflict: true })
  t.is(store.get(y), null)
  t.is(store.bySubAccount('sub_1'), x)
  await approved(store, y, 'sub_2')
  await store.setWallet({ member: x, id: 'w_1', address: ADDR, protectedSymmetricKey: PSK })
  t.alike(await store.setWallet({ member: y, id: 'w_1', address: ADDR2, protectedSymmetricKey: 'other' }), { changed: false, conflict: true })
  t.alike(await store.setWallet({ member: y, id: 'w_2', address: ADDR2, protectedSymmetricKey: PSK }), { changed: false, conflict: true })
  t.is(store.get(y).wallet, null)
  t.is(readFile(file).members[y].wallet, null)
  t.alike(await store.setWallet({ member: y, id: 'w_2', address: ADDR2, protectedSymmetricKey: 'other' }), { changed: true })
})

test('the wrapped key accepts what the Hodle client accepts', async (t) => {
  const { store, open } = setup(t)
  const keys = ['abc.def~!@#$%^&*()[]{}|;:,<>?', 'k'.repeat(4097), 'k'.repeat(8192)]
  for (const key of keys) {
    const m = memberKey()
    await approved(store, m, 'sub_' + key.length)
    t.alike(await store.setWallet({ member: m, id: 'w_' + key.length, address: ADDR, protectedSymmetricKey: key }), { changed: true })
    t.is(open().get(m).wallet.protectedSymmetricKey, key, 'reopens with length ' + key.length)
  }
})

test('revertKycIntent: only the exact submit intent of the attempt goes back to documentos', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  t.alike(await store.revertKycIntent(m, 1), { changed: false }, 'no entry')
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_1', selfieId: 'self_1' })
  t.alike(await store.revertKycIntent(m, 1), { changed: false }, 'not pendente')
  await store.setKyc({ member: m, status: 'pendente', attempt: 1 })
  t.alike(await store.revertKycIntent(m, 2), { changed: false }, 'another attempt')
  const intentAt = store.get(m).kyc.updatedAt
  t.alike(await store.revertKycIntent(m, 1), { changed: true })
  const k = readFile(file).members[m].kyc
  t.is(k.status, 'documentos')
  t.is(k.attempt, 1)
  t.is(k.documentId, 'doc_1')
  t.is(k.selfieId, 'self_1')
  t.ok(k.updatedAt > intentAt, 'stamped after the intent, even in the same millisecond')
  await store.setKyc({ member: m, status: 'pendente', attempt: 1, attemptId: 'att_1' })
  c.t += 1000
  t.alike(await store.revertKycIntent(m, 1), { changed: false }, 'a recorded attempt id is never reverted')
  t.is(store.get(m).kyc.status, 'pendente')
  await typeErrors(t, (a) => store.revertKycIntent(...a), [[m, 0], [m, '1'], ['zz', 1]])
})

test('a reverted intent is not brought back by a stale holder; a newer intent beats the revert', async (t) => {
  const { open, file } = setup(t)
  const a = open()
  const m = memberKey()
  await a.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  await a.setKyc({ member: m, status: 'documentos', documentId: 'doc_1', selfieId: 'self_1' })
  await a.setKyc({ member: m, status: 'pendente', attempt: 1 })
  const stale = open()
  t.is(stale.get(m).kyc.status, 'pendente')
  await a.revertKycIntent(m, 1)
  t.is(await stale.heal(), false, 'nothing to write back')
  t.is(stale.get(m).kyc.status, 'documentos')
  await stale.create({ member: memberKey(), subAccountId: 'sub_other', network: 'polygon' })
  t.is(readFile(file).members[m].kyc.status, 'documentos', 'a later write by the stale holder keeps the revert')

  const old = open()
  await a.setKyc({ member: m, status: 'pendente', attempt: 1 })
  t.is(await old.heal(), false)
  t.is(old.get(m).kyc.status, 'pendente', 'the newer intent wins')
})

test('previousAttemptIds: an old file without the key stays valid and is not rewritten', async (t) => {
  const { open, file, c } = setup(t)
  const m = memberKey()
  const kyc = { status: 'pendente', attempt: 2, attemptId: null, documentId: 'doc_1', selfieId: 'self_1', updatedAt: iso(T0) }
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: { [m]: entry({ kyc }) } }))
  const before = fs.readFileSync(file, 'utf8')
  const store = open()
  t.ok(store.available())
  t.alike(store.get(m).kyc, kyc)
  t.is(await store.heal(), false, 'no migration write')
  t.is(fs.readFileSync(file, 'utf8'), before)
  c.t += 1000
  await store.setKyc({ member: m, status: 'pendente', attempt: 2, attemptId: 'att_2' })
  t.absent('previousAttemptIds' in readFile(file).members[m].kyc, 'the key is written only when non-empty')
})

test('previousAttemptIds: recorded on a new attempt and on a replaced id, bounded to 5, validated', async (t) => {
  const { store, open, file, c } = setup(t)
  const m = memberKey()
  await store.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  for (let i = 1; i <= 7; i++) {
    await store.setKyc({ member: m, status: 'documentos', documentId: 'doc_' + i, selfieId: 'self_' + i })
    await store.setKyc({ member: m, status: 'pendente', attemptId: 'att_' + i })
    c.t += 1000
    await store.setKyc({ member: m, status: 'recusado' })
  }
  await store.setKyc({ member: m, status: 'documentos' })
  t.alike(store.get(m).kyc.previousAttemptIds, ['att_3', 'att_4', 'att_5', 'att_6', 'att_7'])
  t.alike(open().get(m).kyc.previousAttemptIds, ['att_3', 'att_4', 'att_5', 'att_6', 'att_7'], 'persisted')

  const n = memberKey()
  await store.create({ member: n, subAccountId: 'sub_2', network: 'polygon' })
  await store.setKyc({ member: n, status: 'pendente', attemptId: 'att_a' })
  await store.setKyc({ member: n, status: 'pendente', attemptId: 'att_b' })
  t.alike(store.get(n).kyc.previousAttemptIds, ['att_a'])
  t.is(store.get(n).kyc.attemptId, 'att_b')

  for (const bad of [['x', 'x'], ['a', 'b', 'c', 'd', 'e', 'f'], ['bad id'], 'att_a']) {
    fs.writeFileSync(file, JSON.stringify({ v: 1, members: { [m]: entry({ kyc: { ...entry().kyc, previousAttemptIds: bad } }) } }))
    t.absent(open().available(), JSON.stringify(bad))
  }
})

test('previousAttemptIds: the merge keeps the union of both copies', async (t) => {
  const { open, file, c } = setup(t)
  const a = open()
  const m = memberKey()
  await a.create({ member: m, subAccountId: 'sub_1', network: 'polygon' })
  await a.setKyc({ member: m, status: 'pendente', attemptId: 'att_1' })
  const b = open()
  await a.setKyc({ member: m, status: 'pendente', attemptId: 'att_2' })
  // b never saw att_2; its own replacement must not drop att_1 or att_2.
  c.t += 1000
  await b.setKyc({ member: m, status: 'pendente', attemptId: 'att_3' })
  const k = readFile(file).members[m].kyc
  t.ok(k.previousAttemptIds.includes('att_1'))
  t.is(k.attemptId === 'att_2' || k.attemptId === 'att_3', true)
  const other = k.attemptId === 'att_2' ? 'att_3' : 'att_2'
  t.ok(k.previousAttemptIds.includes(other), 'the replaced id of the other copy is kept')
  t.absent(k.previousAttemptIds.includes(k.attemptId), 'the current id is never in the list')
})
