'use strict'

// apps/cli/lib/account/store.js: page names in the account directory. No
// network: keys and records are made locally and the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  createIssuerCert,
  createIssuedCert,
  createUsernameRecord
} = require('@varanda/core/lib/cert')
const { openAccountStore, COOLDOWN_MS, MAX_PAGE_MOVES, RESERVED, FILE } = require('../lib/account/store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-11-03T12:00:00.000Z')
const HOUR = 3600 * 1000
const SIG = 'a'.repeat(128)

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { kp, cert, association: cert.association }
}

function newKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function setup (t) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { t: T0 }
  c.now = () => c.t
  const iss = issuer()
  const open = (opts = {}) => openAccountStore(dir, { now: c.now, ...opts })
  return { dir, c, iss, store: open(), open }
}

function records (iss, key, username, ms) {
  const date = new Date(ms).toISOString()
  return {
    cert: createIssuedCert({ member: key, date }, iss.kp, iss.cert),
    usernameRecord: createUsernameRecord({ member: key, username, date }, iss.kp, iss.cert)
  }
}

function reserve (s, iss, c, key, username) {
  return s.reservePage({ key, username, ...records(iss, key, username, c.t) })
}

function rename (s, iss, c, key, username) {
  const { usernameRecord } = records(iss, key, username, c.t)
  return s.renamePage({ key, username, usernameRecord })
}

function move (s, iss, c, from, to, username) {
  return s.movePage({ from, to, ...records(iss, to, username, c.t) })
}

async function link (s, iss, member, username) {
  const row = s.start({ member, username })
  s.reserve(row.id)
  s.putGoogle(row.id, { sub: 'sub-' + member.slice(0, 8), email: 'm@example.test' })
  return s.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
    return err
  }
}

function throwsCode (t, fn, code, msg) {
  try {
    fn()
    t.fail(msg + ': did not throw')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

test('pagina and paginas are reserved', async (t) => {
  const { store, iss, c } = setup(t)
  t.ok(RESERVED.has('pagina') && RESERVED.has('paginas'))
  await rejects(t, reserve(store, iss, c, newKey(), 'pagina'), 'nome-invalido', 'a page')
  throwsCode(t, () => store.start({ member: newKey(), username: 'paginas' }), 'nome-invalido', 'a person')
})

test('a page name is not given to a person, and a person name is not given to a page', async (t) => {
  const { store, iss, c } = setup(t)
  const page = newKey()
  const res = await reserve(store, iss, c, page, 'padaria')
  t.is(res.usernameRecord.member, page)
  t.is(res.nextChangeAt, new Date(T0 + COOLDOWN_MS).toISOString())

  throwsCode(t, () => store.start({ member: newKey(), username: 'padaria' }), 'nome-em-uso', 'page then person at start')
  const person = newKey()
  await link(store, iss, person, 'pedro')
  c.t += COOLDOWN_MS
  await rejects(t, store.rename(person, 'padaria', iss.kp, iss.cert), 'nome-em-uso', 'page then person at rename')

  await rejects(t, reserve(store, iss, c, newKey(), 'pedro'), 'nome-em-uso', 'person then page')
  await store.rename(person, 'paulo', iss.kp, iss.cert)
  await rejects(t, reserve(store, iss, c, newKey(), 'pedro'), 'nome-em-uso', 'a person past name too')
  await rejects(t, reserve(store, iss, c, newKey(), 'padaria'), 'nome-em-uso', 'a page name for another page')
  await rejects(t, reserve(store, iss, c, page, 'outra'), 'pedido-invalido', 'a key reserved twice')
  await rejects(t, reserve(store, iss, c, person, 'outra'), 'pedido-invalido', 'a linked member key')

  t.alike(store.lookup('paulo'), { member: person, usernameRecord: store.status(person).usernameRecord }, 'person lookup unchanged')
  t.alike(store.lookup('padaria'), { member: page, usernameRecord: res.usernameRecord, kind: 'page' }, 'page lookup')
  t.alike(store.exportLinks().map((l) => l.member), [person], 'export stays people only')
  t.is(store.linkStats().members, 1, 'stats count people only')
})

test('page rename: 7-day cooldown, the old name stays with the page', async (t) => {
  const { store, iss, c } = setup(t)
  const page = newKey()
  await reserve(store, iss, c, page, 'feira')
  const same = await rename(store, iss, c, page, 'feira')
  t.is(same.record.username, 'feira', 'same name: unchanged')

  c.t = T0 + COOLDOWN_MS - HOUR
  const err = await rejects(t, rename(store, iss, c, page, 'mercado'), 'troca-bloqueada', 'refused at +6d23h')
  t.is(err.nextChangeAt, new Date(T0 + COOLDOWN_MS).toISOString())

  c.t = T0 + COOLDOWN_MS
  const res = await rename(store, iss, c, page, 'mercado')
  t.is(res.record.username, 'mercado')
  t.is(store.lookup('mercado').member, page)
  t.is(store.lookup('feira'), null, 'old name left the current holders')
  throwsCode(t, () => store.start({ member: newKey(), username: 'feira' }), 'nome-em-uso', 'and is never given away')
  await rejects(t, rename(store, iss, c, newKey(), 'livre'), 'nao-encontrado', 'unknown page')
})

test('a restart replays the page journal, before and after a clean close', async (t) => {
  const { store, iss, c, open } = setup(t)
  const page = newKey()
  const person = newKey()
  await link(store, iss, person, 'rita')
  const res = await reserve(store, iss, c, page, 'oficina')

  const ro = open({ readOnly: true })
  t.alike(ro.lookup('oficina'), { member: page, usernameRecord: res.usernameRecord, kind: 'page' }, 'replayed from the journal')
  t.is(ro.pageStatus(page).username, 'oficina')

  await store.close()
  const again = open()
  t.alike(again.lookup('oficina'), { member: page, usernameRecord: res.usernameRecord, kind: 'page' }, 'after close')
  t.is(again.lookup('rita').member, person)
  throwsCode(t, () => again.start({ member: newKey(), username: 'oficina' }), 'nome-em-uso', 'still held')
  await again.close()
})

test('a snapshot that keeps a page name holder but drops the pages fails closed', async (t) => {
  const { store, iss, c, dir } = setup(t)
  await link(store, iss, newKey(), 'rui')
  await reserve(store, iss, c, newKey(), 'loja')
  await store.close()
  const file = path.join(dir, FILE)
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.ok(snap.pages && snap.pagesByUsername, 'the snapshot carries the pages')

  const without = { ...snap }
  delete without.pages
  delete without.pagesByUsername
  fs.writeFileSync(file, JSON.stringify(without))
  t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, 'pages dropped')

  const noIndex = { ...snap }
  delete noIndex.pagesByUsername
  fs.writeFileSync(file, JSON.stringify(noIndex))
  t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, 'index dropped')

  fs.writeFileSync(file, JSON.stringify(snap))
  t.is(openAccountStore(dir, { readOnly: true }).lookup('loja').kind, 'page', 'the intact snapshot reads again')
})

test('a directory without pages writes no page fields', async (t) => {
  const { store, iss, dir } = setup(t)
  await link(store, iss, newKey(), 'vera')
  await store.close()
  const snap = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  t.absent('pages' in snap)
  t.absent('pagesByUsername' in snap)
})

test('close keeps the name held both ways and lookup says closed', async (t) => {
  const { store, iss, c, open } = setup(t)
  const page = newKey()
  const res = await reserve(store, iss, c, page, 'cafe')
  const closed = await store.closePage({ key: page })
  t.is(closed.closed, new Date(T0).toISOString())

  t.alike(store.lookup('cafe'), { member: page, usernameRecord: res.usernameRecord, kind: 'page', closed: true })
  throwsCode(t, () => store.start({ member: newKey(), username: 'cafe' }), 'nome-em-uso', 'a person')
  await rejects(t, reserve(store, iss, c, newKey(), 'cafe'), 'nome-em-uso', 'another page')
  await rejects(t, store.closePage({ key: page }), 'pedido-invalido', 'closed twice')
  c.t += COOLDOWN_MS
  await rejects(t, rename(store, iss, c, page, 'bar'), 'pedido-invalido', 'a closed page is not renamed')
  await rejects(t, move(store, iss, c, page, newKey(), 'cafe'), 'pedido-invalido', 'nor moved')
  await rejects(t, store.closePage({ key: newKey() }), 'nao-encontrado', 'unknown page')

  t.is(open({ readOnly: true }).lookup('cafe').closed, true, 'replayed')
})

test('move: the name resolves to the new key, replays, keeps the cooldown; the old key cannot move again', async (t) => {
  const { store, iss, c, open } = setup(t)
  const k1 = newKey()
  const k2 = newKey()
  await reserve(store, iss, c, k1, 'horta')
  c.t += HOUR
  const res = await move(store, iss, c, k1, k2, 'horta')
  t.is(res.usernameRecord.member, k2)
  t.is(res.nextChangeAt, new Date(T0 + COOLDOWN_MS).toISOString(), 'the cooldown is not reset')

  t.alike(store.lookup('horta'), { member: k2, usernameRecord: res.usernameRecord, kind: 'page' })
  const old = store.pageStatus(k1)
  t.is(old.username, null)
  t.is(old.usernameRecord, null, 'the old key keeps no record for the given-up name')
  t.is(old.movedTo, k2)
  t.is(store.pageStatus(k2).movedFrom, k1)
  t.is(store.pageStatus(k2).createdAt, new Date(T0).toISOString())

  await rejects(t, rename(store, iss, c, k2, 'pomar'), 'troca-bloqueada', 'cooldown still applies after the move')
  await rejects(t, move(store, iss, c, k1, newKey(), 'horta'), 'pedido-invalido', 'a second move of the old key')
  await rejects(t, store.closePage({ key: k1 }), 'pedido-invalido', 'a moved page is not closed')
  await rejects(t, move(store, iss, c, k2, k1, 'horta'), 'pedido-invalido', 'back to a used key')
  throwsCode(t, () => store.start({ member: newKey(), username: 'horta' }), 'nome-em-uso', 'the name stays held')

  t.is(open({ readOnly: true }).lookup('horta').member, k2, 'replayed from the journal')
  await store.close()
  const again = open()
  t.is(again.lookup('horta').member, k2, 'replayed after close')
  t.is(again.pageStatus(k1).movedTo, k2)
  c.t = T0 + COOLDOWN_MS
  const renamed = await rename(again, iss, c, k2, 'pomar')
  t.is(renamed.record.username, 'pomar')
  c.t += COOLDOWN_MS
  const back = await rename(again, iss, c, k2, 'horta')
  t.is(back.record.username, 'horta', 'the new key takes back a name the page used before the move')
  await again.close()
})

test('a fifth move in a chain is refused', async (t) => {
  const { store, iss, c, open } = setup(t)
  t.is(MAX_PAGE_MOVES, 4)
  let key = newKey()
  await reserve(store, iss, c, key, 'banca')
  for (let i = 0; i < MAX_PAGE_MOVES; i++) {
    const next = newKey()
    await move(store, iss, c, key, next, 'banca')
    key = next
  }
  await rejects(t, move(store, iss, c, key, newKey(), 'banca'), 'pedido-invalido', 'the fifth move')
  t.is(store.lookup('banca').member, key)
  await store.close()
  t.is(open({ readOnly: true }).lookup('banca').member, key, 'a chain of four replays')
})

test('journal: a page line that breaks an invariant fails closed', async (t) => {
  const { store, iss, c, dir } = setup(t)
  const page = newKey()
  await reserve(store, iss, c, page, 'sebo')
  const snap = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  const log = path.join(dir, 'directory.journal.' + snap.journal)
  const good = fs.readFileSync(log, 'utf8')
  const line = JSON.parse(good.trim().split('\n')[1])
  const refused = (text, msg) => {
    fs.writeFileSync(log, text)
    t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, msg)
  }
  refused(good + JSON.stringify({ ...line, seq: 2 }) + '\n', 'the same key reserved twice')
  refused(good + JSON.stringify({ ...line, seq: 2, key: newKey() }) + '\n', 'the same name for another page')
  refused(good + JSON.stringify({ seq: 2, op: 'page-close', key: newKey(), at: line.at }) + '\n', 'closing an unknown page')
  fs.writeFileSync(log, good)
  t.is(openAccountStore(dir, { readOnly: true }).lookup('sebo').member, page, 'the intact journal reads again')
})

test('a page key is never a new member, and status does not call it free', async (t) => {
  const { store, iss, c } = setup(t)
  const page = newKey()
  const moved = newKey()
  await reserve(store, iss, c, page, 'feira')
  t.alike(store.status(page), { linked: false, unavailable: true }, 'a page key')
  t.alike(store.status(newKey()), { linked: false }, 'a free key is unchanged')
  throwsCode(t, () => store.start({ member: page, username: 'outro' }), 'conta-vinculada', 'a page key at start')
  throwsCode(t, () => store.start({ member: page.toUpperCase(), username: 'outro' }), 'conta-vinculada', 'in upper case too')
  await move(store, iss, c, page, moved, 'feira')
  throwsCode(t, () => store.start({ member: page, username: 'outro' }), 'conta-vinculada', 'the moved old key')
  throwsCode(t, () => store.start({ member: moved, username: 'outro' }), 'conta-vinculada', 'the new key')
  t.alike(store.status(page), { linked: false, unavailable: true }, 'the moved old key')
})

test('journal: a page rename or move whose name does not match the page fails closed', async (t) => {
  const { store, iss, c, dir } = setup(t)
  const k1 = newKey()
  const k2 = newKey()
  await reserve(store, iss, c, k1, 'acai')
  c.t += COOLDOWN_MS
  await rename(store, iss, c, k1, 'bolo')
  c.t += COOLDOWN_MS
  await rename(store, iss, c, k1, 'caju')
  await move(store, iss, c, k1, k2, 'caju')
  const snap = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  const log = path.join(dir, 'directory.journal.' + snap.journal)
  const good = fs.readFileSync(log, 'utf8')
  const lines = good.trim().split('\n')
  const renameLine = JSON.parse(lines[2])
  const moveLine = JSON.parse(lines[4])
  t.is(renameLine.previous, 'acai', 'the rename line carries the previous name')
  t.is(moveLine.username, 'caju', 'the move line carries the moved name')
  const tamper = (i, line) => lines.map((l, j) => j === i ? JSON.stringify(line) : l).join('\n') + '\n'
  const refused = (text, msg) => {
    fs.writeFileSync(log, text)
    t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, msg)
  }
  refused(tamper(2, { ...renameLine, previous: 'bolo' }), 'a rename from a name the page does not hold')
  const noPrevious = { ...renameLine }
  delete noPrevious.previous
  refused(tamper(2, noPrevious), 'a rename without previous')
  refused(tamper(2, { ...renameLine, usernameRecord: { ...renameLine.usernameRecord, username: 'outro' } }), 'a rename record for another name')
  refused(tamper(4, { ...moveLine, username: 'bolo' }), 'a move of a name the page does not hold')
  refused(tamper(4, { ...moveLine, usernameRecord: { ...moveLine.usernameRecord, username: 'bolo' } }), 'a move record for another name')
  refused(tamper(4, { ...moveLine, usernameRecord: { ...moveLine.usernameRecord, member: k1 } }), 'a move record for another key')
  fs.writeFileSync(log, good)
  t.is(openAccountStore(dir, { readOnly: true }).lookup('caju').member, k2, 'the intact journal reads again')
})

test('a snapshot whose page record does not match the page fails closed', async (t) => {
  const { store, iss, c, dir } = setup(t)
  const k1 = newKey()
  const k2 = newKey()
  await reserve(store, iss, c, k1, 'quitanda')
  await move(store, iss, c, k1, k2, 'quitanda')
  await store.close()
  const file = path.join(dir, FILE)
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.is(snap.pages[k1].usernameRecord, null, 'the moved entry carries no record')
  const refused = (pages, msg) => {
    fs.writeFileSync(file, JSON.stringify({ ...snap, pages: { ...snap.pages, ...pages } }))
    t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, msg)
  }
  refused({ [k1]: { ...snap.pages[k1], usernameRecord: snap.pages[k2].usernameRecord } }, 'a moved entry that keeps a record')
  refused({ [k2]: { ...snap.pages[k2], usernameRecord: { ...snap.pages[k2].usernameRecord, member: k1 } } }, 'a record for another key')
  refused({ [k2]: { ...snap.pages[k2], usernameRecord: { ...snap.pages[k2].usernameRecord, username: 'outro' } } }, 'a record for another name')
  fs.writeFileSync(file, JSON.stringify(snap))
  t.is(openAccountStore(dir, { readOnly: true }).lookup('quitanda').member, k2, 'the intact snapshot reads again')
})

test('store: closeOrphanPages closes the live pages neither the writer nor the ACL holds, and the service start does it with a count only', async (t) => {
  const { closeOrphanPages } = require('../lib/commands/account')
  const { c, iss, store } = setup(t)
  const kept = newKey()
  const orphan = newKey()
  await reserve(store, iss, c, kept, 'mantida')
  await reserve(store, iss, c, orphan, 'orfa')
  const logs = []
  const writer = { ready: async () => {}, pageKeys: () => [kept] }
  const acl = { available: () => true, get: () => null }
  await closeOrphanPages(store, writer, acl, (e) => logs.push(e))
  t.is(store.pageStatus(kept).closed, null, 'a page the writer holds stays live')
  t.ok(store.pageStatus(orphan).closed, 'the orphan is closed')
  t.alike(logs, [{ event: 'paginas', reason: 'orfas-encerradas', count: 1 }], 'a count only, never a key')
  t.is(await store.closeOrphanPages(() => { throw new Error('x') }), 0, 'a failing check keeps every page')
  t.is(await store.closeOrphanPages(() => false), 1, 'already closed pages are skipped')
})
