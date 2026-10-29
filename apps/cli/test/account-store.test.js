'use strict'

// apps/cli/lib/account/store.js: the account directory on disk. No network:
// keys and certificates are made locally and the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  createIssuerCert,
  verifyCert,
  verifyUsernameRecord
} = require('@varanda/core/lib/cert')
const { openAccountStore, COOLDOWN_MS, PENDING_TTL_MS, MAX_PENDING, MAX_UNPROVEN_PER_MEMBER, MAX_PER_SUB, FILE, JOURNAL_PREFIX, HWM, journalPath, COMPACT_EVERY, ORPHAN_GRACE_MS } = require('../lib/account/store')
const { LOCK_STALE_MS, LOCK_HEARTBEAT_MS } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-24T12:00:00.000Z')
const HOUR = 3600 * 1000
const SIG = 'a'.repeat(128)

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { kp, cert, association: cert.association }
}

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const iss = issuer()
  const open = () => openAccountStore(dir, { now: c.now })
  return { dir, c, iss, store: open(), open, ...opts }
}

async function link (s, iss, member, username, sub = 'sub-' + member.slice(0, 8), email = 'm@example.test') {
  const row = s.start({ member, username })
  s.reserve(row.id)
  s.putGoogle(row.id, { sub, email })
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

test('pending row shape: random base64url secrets and a 600 s TTL', (t) => {
  const { store, c } = setup(t)
  const row = store.start({ member: memberKey(), username: 'ana' })
  for (const k of ['id', 'nonce', 'state', 'verifier']) {
    t.ok(/^[A-Za-z0-9_-]{43}$/.test(row[k]), k + ' is 32 bytes base64url')
  }
  t.is(row.phase, 'reserve')
  t.is(row.expiresAt, c.t + PENDING_TTL_MS)
  t.alike(store.get(row.id), row)
  c.t += PENDING_TTL_MS
  t.is(store.get(row.id), null, 'expired row is gone')
})

test('reserved and invalid names are refused', (t) => {
  const { store } = setup(t)
  const member = memberKey()
  for (const name of ['admin', 'associacao', 'association', 'ajuda', 'mod', 'moderacao', 'root', 'seeder', 'semeador', 'suporte', 'support', 'varanda']) {
    throwsCode(t, () => store.start({ member, username: name }), 'nome-invalido', name)
  }
  for (const name of ['ab', 'Ana', '1ana', 'abc123', 'a'.repeat(21), '__proto__']) {
    throwsCode(t, () => store.start({ member, username: name }), 'nome-invalido', JSON.stringify(name))
  }
  t.ok(store.start({ member, username: 'admins' }), 'a reserved name is matched exactly')
})

test('a Google-claimed row holds the name until it expires; a key proof alone holds nothing', (t) => {
  const { store, c } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const rowA = store.start({ member: a, username: 'bia' })
  t.ok(store.start({ member: b, username: 'bia' }), 'unreserved: another member may start')
  store.reserve(rowA.id)
  t.ok(store.start({ member: b, username: 'bia' }), 'key-proven only: still not held (keys are free)')
  store.putGoogle(rowA.id, { sub: 'sub-bia', email: 'b@example.test' })
  throwsCode(t, () => store.start({ member: b, username: 'bia' }), 'nome-em-uso', 'held once Google answered')
  t.ok(store.start({ member: a, username: 'bia' }), 'the same member may start again')
  c.t += PENDING_TTL_MS
  t.ok(store.start({ member: b, username: 'bia' }), 'released when the row expires')
  throwsCode(t, () => store.reserve(rowA.id), 'expirado', 'an expired row cannot be reserved')
})

// Distinct members and names without key generation: a member is any 64 hex.
function fillerMember (i) {
  return i.toString(16).padStart(64, 'f')
}

function fillerName (i) {
  return 'user_' + i
}

test('a full table evicts the oldest unproven row', (t) => {
  const { store } = setup(t)
  const rows = []
  for (let i = 0; i < MAX_PENDING; i++) rows.push(store.start({ member: fillerMember(i), username: fillerName(i) }))
  const extra = store.start({ member: memberKey(), username: 'extra' })
  t.is(store.get(rows[0].id), null, 'the oldest unproven row is evicted')
  t.ok(store.get(rows[1].id), 'the next one stays')
  t.ok(store.get(extra.id), 'the new row is live')
})

test('a full table evicts the oldest row without sub (a key-proven one here) and keeps the Google-claimed one', async (t) => {
  const { store, iss } = setup(t)
  const a = memberKey()
  const reserved = store.start({ member: a, username: 'bia' })
  store.reserve(reserved.id)
  const b = memberKey()
  const claimed = store.start({ member: b, username: 'caio' })
  store.putGoogle(claimed.id, { sub: 'sub-caio', email: 'c@example.test' })
  const rows = []
  for (let i = 2; i < MAX_PENDING; i++) rows.push(store.start({ member: fillerMember(i), username: fillerName(i) }))
  store.start({ member: memberKey(), username: 'extra' })
  t.is(store.get(reserved.id), null, 'the key-proven row is the oldest row without sub: evicted')
  t.ok(store.get(claimed.id), 'the row holding Google claims survives')
  t.ok(store.get(rows[0].id), 'the next row without sub stays')
  t.ok(store.start({ member: memberKey(), username: 'bia' }), 'a key-proven row never held its name')
  throwsCode(t, () => store.start({ member: memberKey(), username: 'caio' }), 'nome-em-uso', 'the claimed row holds its name')
  for (let i = 0; i < 3; i++) store.start({ member: memberKey(), username: 'mais_' + i })
  t.ok(store.get(claimed.id), 'the claimed row is never evicted for room')
  const res = await store.finish(claimed.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.is(res.cert.member, b, 'and still completes')
})

test('two Google-claimed rows for one name: the first to claim holds it, the other fails at finish', async (t) => {
  const { store, iss } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const rowA = store.start({ member: a, username: 'bia' })
  const rowB = store.start({ member: b, username: 'bia' })
  store.putGoogle(rowB.id, { sub: 'sub-b', email: 'b@example.test' })
  store.putGoogle(rowA.id, { sub: 'sub-a', email: 'a@example.test' })
  throwsCode(t, () => store.start({ member: a, username: 'bia' }), 'nome-em-uso', 'b claimed first and holds the name')
  t.ok(store.start({ member: b, username: 'bia' }), 'the holder may start again')
  await rejects(t, store.finish(rowA.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'nome-em-uso', 'the later claim fails at finish')
  const res = await store.finish(rowB.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.is(res.usernameRecord.username, 'bia', 'the first claim is never blocked by the later one')
})

test('a third live row for the same Google subject replaces its oldest', (t) => {
  const { store } = setup(t)
  const rows = []
  for (let i = 0; i < 3; i++) rows.push(store.start({ member: memberKey(), username: fillerName(i) }))
  store.putGoogle(rows[0].id, { sub: 'sub-x', email: 'x@example.test' })
  store.putGoogle(rows[1].id, { sub: 'sub-x', email: 'x@example.test' })
  t.ok(store.get(rows[0].id) && store.get(rows[1].id), 'two rows per sub are allowed (a double click)')
  store.putGoogle(rows[2].id, { sub: 'sub-x', email: 'x@example.test' })
  t.is(store.get(rows[0].id), null, 'the oldest row of that sub is replaced')
  t.ok(store.get(rows[1].id), 'the second stays')
  t.is(store.get(rows[2].id).sub, 'sub-x', 'the new one is claimed')
  const other = store.start({ member: memberKey(), username: 'outra' })
  store.putGoogle(other.id, { sub: 'sub-y', email: 'y@example.test' })
  t.ok(store.get(rows[1].id) && store.get(rows[2].id), 'another sub touches nothing')
  store.putGoogle(rows[2].id, { sub: 'sub-x', email: 'x2@example.test' })
  t.ok(store.get(rows[1].id), 'a repeated claim on the same row counts it once')
})

test('a table full of Google-claimed rows refuses with lotado and changes nothing', (t) => {
  const { store, c } = setup(t)
  const rows = []
  for (let i = 0; i < MAX_PENDING; i++) {
    const row = store.start({ member: fillerMember(i), username: fillerName(i) })
    // MAX_PER_SUB rows per subject: every claim costs a Google account.
    store.putGoogle(row.id, { sub: 'sub-' + Math.floor(i / MAX_PER_SUB), email: 'x@example.test' })
    rows.push(row)
  }
  throwsCode(t, () => store.start({ member: memberKey(), username: 'extra' }), 'lotado', 'no unproven row to evict')
  t.ok(store.get(rows[0].id), 'the oldest claimed row is still live')
  t.ok(store.get(rows[MAX_PENDING - 1].id), 'the newest claimed row is still live')
  c.t += PENDING_TTL_MS
  t.ok(store.start({ member: memberKey(), username: 'extra' }), 'room again once the rows expire')
})

test('a member over its unproven cap replaces its own oldest unproven row', (t) => {
  const { store } = setup(t)
  const a = memberKey()
  const other = store.start({ member: memberKey(), username: 'outro' })
  const rows = []
  for (let i = 0; i < MAX_UNPROVEN_PER_MEMBER; i++) rows.push(store.start({ member: a, username: fillerName(i) }))
  store.putGoogle(rows[1].id, { sub: 'sub-a', email: 'a@example.test' })
  const r4 = store.start({ member: a, username: 'quarto' })
  t.ok(store.get(rows[0].id), 'below the cap after a Google claim: nothing evicted')
  const r5 = store.start({ member: a, username: 'quinto' })
  t.is(store.get(rows[0].id), null, 'its oldest unproven row is replaced')
  for (const row of [rows[1], rows[2], r4, r5, other]) t.ok(store.get(row.id), 'other rows stay')
})

test('finish issues the v2 cert and the first username record, persisted 0o600 in a 0o700 dir', async (t) => {
  const { store, iss, dir, open, c } = setup(t)
  const member = memberKey()
  const res = await link(store, iss, member, 'caio')
  t.ok(verifyCert(res.cert, iss.association).ok, 'cert verifies')
  t.is(res.cert.v, 2)
  t.ok(verifyUsernameRecord(res.usernameRecord, member, iss.association).ok, 'record verifies')
  t.is(res.usernameRecord.username, 'caio')
  t.is(res.nextChangeAt, new Date(c.t + COOLDOWN_MS).toISOString())

  t.is(fs.statSync(dir).mode & 0o777, 0o700)
  t.is(fs.statSync(path.join(dir, FILE)).mode & 0o777, 0o600)
  t.is(fs.statSync(journalFile(dir)).mode & 0o777, 0o600, 'the journal too')
  t.absent(fs.readFileSync(journalFile(dir), 'utf8').includes('verifier'), 'no pending secret in the journal')
  // A clean close folds the journal into a complete v 1 snapshot.
  await store.close()
  const disk = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  t.is(disk.v, 1)
  t.is(disk.bySub['sub-' + member.slice(0, 8)], member)
  t.is(disk.byUsername.caio, member)
  t.is(disk.usedNames.caio, member)
  t.absent('verifier' in disk.links[member], 'no pending secret on disk')
  t.absent(JSON.stringify(disk).includes('verifier'))

  const again = open()
  t.alike(again.status(member), { linked: true, username: 'caio', cert: res.cert, usernameRecord: res.usernameRecord, nextChangeAt: res.nextChangeAt })
  t.alike(again.lookup('caio'), { member, usernameRecord: res.usernameRecord })
  t.is(again.lookup('ninguem'), null)
})

test('after a successful finish, a retry is expirado and status returns the identical cert', async (t) => {
  const { store, iss } = setup(t)
  const member = memberKey()
  const row = store.start({ member, username: 'davi' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: 'sub-davi', email: 'd@example.test' })
  const res = await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'expirado', 'row is single-use')
  t.is(store.status(member).cert, res.cert, 'the same cert object')
})

test('a second row for an already linked sub+member returns the stored cert and updates the email', async (t) => {
  const { store, iss } = setup(t)
  const member = memberKey()
  // Two rows started before either finished (a double click).
  const r1 = store.start({ member, username: 'eva' })
  const r2 = store.start({ member, username: 'eva' })
  for (const r of [r1, r2]) {
    store.reserve(r.id)
  }
  store.putGoogle(r1.id, { sub: 'sub-eva', email: 'old@example.test' })
  store.putGoogle(r2.id, { sub: 'sub-eva', email: 'new@example.test' })
  const first = await store.finish(r1.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  const second = await store.finish(r2.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.alike(second.cert, first.cert, 'identical cert')
  t.alike(second.usernameRecord, first.usernameRecord)
  t.is(store.exportLinks()[0].email, 'new@example.test')
})

test('conflicts: a sub linked to another member, a member linked to another sub, a name taken', async (t) => {
  const { store, iss } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'fabi', 'sub-a')

  // Same Google account, another diary.
  const rb = store.start({ member: b, username: 'gabi' })
  store.putGoogle(rb.id, { sub: 'sub-a', email: 'x@example.test' })
  await rejects(t, store.finish(rb.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'conta-vinculada', 'sub already linked')

  // Same diary, another Google account (two rows started before the link).
  const c = memberKey()
  const r1 = store.start({ member: c, username: 'hugo' })
  const r2 = store.start({ member: c, username: 'hugo' })
  store.putGoogle(r1.id, { sub: 'sub-c1', email: 'c@example.test' })
  store.putGoogle(r2.id, { sub: 'sub-c2', email: 'c@example.test' })
  await store.finish(r1.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  await rejects(t, store.finish(r2.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'conta-vinculada', 'member already linked')
  throwsCode(t, () => store.start({ member: c, username: 'outro' }), 'conta-vinculada', 'a linked member cannot start')

  // Name taken: at start and, for a row started earlier, at finish.
  const d = memberKey()
  throwsCode(t, () => store.start({ member: d, username: 'fabi' }), 'nome-em-uso', 'held name at start')
  const e = memberKey()
  const f = memberKey()
  const re = store.start({ member: e, username: 'iris' })
  const rf = store.start({ member: f, username: 'iris' })
  store.putGoogle(re.id, { sub: 'sub-e', email: 'e@example.test' })
  store.putGoogle(rf.id, { sub: 'sub-f', email: 'f@example.test' })
  await store.finish(re.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  await rejects(t, store.finish(rf.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'nome-em-uso', 'taken at finish')
  t.is(store.status(f).linked, false)
})

test('a killed append leaves the previous directory and no link; the torn line is truncated away', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'joao', 'sub-joao')
  const file = path.join(dir, FILE)
  const log = journalFile(dir)
  const before = fs.readFileSync(file, 'utf8')
  const beforeLog = fs.readFileSync(log, 'utf8')

  const b = memberKey()
  const row = store.start({ member: b, username: 'kira' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: 'sub-kira', email: 'k@example.test' })
  // The append writes half of its line, then the process "dies" (EIO).
  const writeSync = fs.writeSync
  fs.writeSync = (fd, buf, off, len) => {
    fs.writeSync = writeSync
    writeSync.call(fs, fd, buf, off, Math.floor(len / 2))
    throw Object.assign(new Error('killed'), { code: 'EIO' })
  }
  try {
    await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'write fails')
  } finally {
    fs.writeSync = writeSync
  }
  t.is(fs.readFileSync(file, 'utf8'), before, 'previous snapshot intact')
  t.is(fs.readFileSync(log, 'utf8'), beforeLog, 'the torn line is truncated away')
  t.ok(openAccountStore(dir, { readOnly: true }).status(a).linked, 'previous directory readable')
  t.alike(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left')
  t.is(store.status(b).linked, false, 'memory unchanged')
  t.is(openAccountStore(dir, { readOnly: true }).status(b).linked, false, 'disk unchanged')
  t.is(store.lookup('kira'), null)

  const res = await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.ok(res.cert, 'the row survives the failure, so a retry succeeds')
  t.is(openAccountStore(dir, { readOnly: true }).status(b).username, 'kira')
})

// Makes every fsync throw `fault.code` while it is set. A change is one
// complete appended line followed by the journal fsync, so the line is
// already in the file (published) when the error is raised.
function fsyncFault (t) {
  const { fsyncSync } = fs
  t.teardown(() => { fs.fsyncSync = fsyncSync }, { force: true })
  const fault = { code: null }
  fs.fsyncSync = function (fd) {
    if (fault.code !== null) throw Object.assign(new Error('simulado'), { code: fault.code })
    return fsyncSync.call(fs, fd)
  }
  return fault
}

test('an append whose fsync fails: the store becomes unavailable and adopts nothing', async (t) => {
  const { store, iss, dir } = setup(t)
  const fault = fsyncFault(t)
  // A first link writes the v 2 snapshot, so the faulted finish is an append only.
  const a = memberKey()
  await link(store, iss, a, 'primeira')
  const b = memberKey()
  const row = store.start({ member: b, username: 'kira' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: 'sub-kira', email: 'k@example.test' })

  fault.code = 'EIO'
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'the call fails')
  fault.code = null

  t.is(store.status(b).linked, false, 'memory never adopts a line whose fsync failed')
  t.is(store.lookup('kira'), null)
  t.is(store.status(a).linked, true, 'earlier links still read')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'a retry is refused')
  await rejects(t, store.rename(a, 'outra', iss.kp, iss.cert), 'indisponivel', 'every mutation is refused')
  // The line reached the page cache: a reopen reads what is on disk.
  t.is(openAccountStore(dir, { readOnly: true }).status(b).linked, true, 'reopening reads what is on disk')
})

test('a rename whose journal fsync fails: the store becomes unavailable and keeps the old name', async (t) => {
  const { store, iss, c, dir } = setup(t)
  const fault = fsyncFault(t)
  const member = memberKey()
  await link(store, iss, member, 'lara')
  c.t = T0 + COOLDOWN_MS

  fault.code = 'EIO'
  await rejects(t, store.rename(member, 'luna', iss.kp, iss.cert), 'EIO', 'the call fails')
  fault.code = null

  t.is(store.status(member).username, 'lara', 'memory keeps the old name')
  t.is(store.lookup('luna'), null)
  await rejects(t, store.rename(member, 'luna', iss.kp, iss.cert), 'indisponivel', 'a retry is refused')
  t.is(openAccountStore(dir, { readOnly: true }).status(member).username, 'luna', 'reopening reads what is on disk')
})

test('journal: a data dir fsync that fails after a journal is created discards it; the next open creates and fsyncs another', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const { fsyncSync, openSync } = fs
  t.teardown(() => { fs.fsyncSync = fsyncSync; fs.openSync = openSync }, { force: true })
  // Armed when the first journal file is created (by the first rw open);
  // the next directory fsync then fails once. File fsyncs (the journal,
  // the snapshot temp file) never fail.
  let armed = false
  let created = 0
  let dirFsyncs = 0
  fs.openSync = function (p, flags, ...rest) {
    const fd = openSync.call(fs, p, flags, ...rest)
    if (path.basename(p).startsWith(JOURNAL_PREFIX) && typeof flags === 'number' && (flags & fs.constants.O_CREAT) && created++ === 0) armed = true
    return fd
  }
  fs.fsyncSync = function (fd) {
    if (fs.fstatSync(fd).isDirectory()) {
      dirFsyncs++
      if (armed) {
        armed = false
        throw Object.assign(new Error('simulado'), { code: 'EIO' })
      }
    }
    return fsyncSync.call(fs, fd)
  }

  t.exception(() => openAccountStore(dir), /simulado/, 'the open fails like a failed change')
  t.alike(journalIds(dir), [], 'the journal nothing names is removed')
  t.absent(fs.existsSync(path.join(dir, FILE)), 'no snapshot was written')

  dirFsyncs = 0
  const store = openAccountStore(dir)
  t.is(dirFsyncs, 2, 'the next open fsyncs the data dir for the new journal, then for the v 2 snapshot')
  t.is(journalIds(dir).length, 1, 'one journal, the one the snapshot names')
  t.alike(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left')

  const a = memberKey()
  dirFsyncs = 0
  await link(store, iss, a, 'joao')
  t.is(dirFsyncs, 0, 'a change does not repeat it')
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'joao', 'the link is on disk')
})

test('a failed write whose file cannot be reloaded marks the store unavailable', async (t) => {
  const { store, iss, dir, c } = setup(t)
  const fault = fsyncFault(t)
  const member = memberKey()
  await link(store, iss, member, 'mila')
  c.t = T0 + COOLDOWN_MS

  const { readFileSync } = fs
  t.teardown(() => { fs.readFileSync = readFileSync }, { force: true })
  fs.readFileSync = () => { throw Object.assign(new Error('simulado'), { code: 'EIO' }) }
  fault.code = 'EIO'
  await rejects(t, store.rename(member, 'mona', iss.kp, iss.cert), 'EIO', 'the original error propagates')
  fault.code = null
  fs.readFileSync = readFileSync

  t.is(store.status(member).username, 'mila', 'the old in-memory state is kept')
  await rejects(t, store.rename(member, 'mona', iss.kp, iss.cert), 'indisponivel', 'rename refused')
  const other = memberKey()
  const row = store.start({ member: other, username: 'nora' })
  store.putGoogle(row.id, { sub: 'sub-nora', email: 'n@example.test' })
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'finish refused')
  t.is(openAccountStore(dir, { readOnly: true }).status(member).username, 'mona', 'the published line is untouched')
})

test('rename: 7-day cooldown with an injected clock', async (t) => {
  const { store, iss, c, dir } = setup(t)
  const member = memberKey()
  const first = await link(store, iss, member, 'lara')

  const same = await store.rename(member, 'lara', iss.kp, iss.cert)
  t.alike(same, { record: first.usernameRecord, nextChangeAt: first.nextChangeAt }, 'same name: unchanged')

  c.t = T0 + COOLDOWN_MS - HOUR
  const err = await rejects(t, store.rename(member, 'luna', iss.kp, iss.cert), 'troca-bloqueada', 'refused at +6d23h')
  t.is(err.nextChangeAt, first.nextChangeAt)
  t.is(store.status(member).username, 'lara')

  c.t = T0 + COOLDOWN_MS
  const res = await store.rename(member, 'luna', iss.kp, iss.cert)
  t.is(res.record.username, 'luna')
  t.ok(verifyUsernameRecord(res.record, member, iss.association).ok)
  t.is(res.nextChangeAt, new Date(c.t + COOLDOWN_MS).toISOString())
  t.is(store.lookup('lara'), null, 'old name released from the current holders')
  t.alike(store.lookup('luna'), { member, usernameRecord: res.record })

  const st = openAccountStore(dir, { readOnly: true }).status(member)
  t.is(st.username, 'luna', 'persisted')
  t.alike(st.usernameRecord, res.record)
  t.is(st.nextChangeAt, res.nextChangeAt)
  t.alike(st.cert, first.cert, 'the certificate does not change')

  await rejects(t, store.rename(memberKey(), 'nina', iss.kp, iss.cert), 'nao-encontrado', 'unlinked member')
  c.t += COOLDOWN_MS
  await rejects(t, store.rename(member, 'admin', iss.kp, iss.cert), 'nome-invalido', 'reserved name')
})

test('a used name is never given to another member; its owner may take it back', async (t) => {
  const { store, iss, c } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'olga', 'sub-a')
  c.t += COOLDOWN_MS
  await store.rename(a, 'otto', iss.kp, iss.cert)

  throwsCode(t, () => store.start({ member: b, username: 'olga' }), 'nome-em-uso', 'released name stays used at start')
  await link(store, iss, b, 'paulo', 'sub-b')
  c.t += COOLDOWN_MS
  await rejects(t, store.rename(b, 'olga', iss.kp, iss.cert), 'nome-em-uso', 'and at rename')
  await rejects(t, store.rename(b, 'otto', iss.kp, iss.cert), 'nome-em-uso', 'a current name too')

  const back = await store.rename(a, 'olga', iss.kp, iss.cert)
  t.is(back.record.username, 'olga', 'the same member takes it back')
  t.is(store.lookup('olga').member, a)
  t.is(store.lookup('otto'), null)
})

test('exportLinks has the email and no signature, cert or secret', async (t) => {
  const { store, iss } = setup(t)
  const member = memberKey()
  await link(store, iss, member, 'rita', 'sub-rita', 'rita@example.test')
  const rows = store.exportLinks()
  t.is(rows.length, 1)
  t.alike(Object.keys(rows[0]).sort(), ['email', 'linkedAt', 'member', 'sub', 'username'])
  t.is(rows[0].email, 'rita@example.test')
  t.absent(JSON.stringify(rows).includes(SIG), 'no signature')
})

test('linkStats: member total, cap and sign-ups per UTC day; counts only', async (t) => {
  const { dir, c, iss, store } = setup(t)
  c.t = Date.parse('2026-10-01T09:00:00.000Z')
  await link(store, iss, memberKey(), 'ana', 'sub-ana', 'ana@example.test')
  c.t = Date.parse('2026-10-01T23:59:00.000Z')
  await link(store, iss, memberKey(), 'beto', 'sub-beto', 'beto@example.test')
  c.t = Date.parse('2026-10-02T00:01:00.000Z')
  await link(store, iss, memberKey(), 'caio', 'sub-caio', 'caio@example.test')

  const want = { members: 3, maxMembers: null, byDay: [['2026-10-01', 2], ['2026-10-02', 1]] }
  const stats = store.linkStats()
  t.alike(stats, want)
  t.alike(Object.keys(stats).sort(), ['byDay', 'maxMembers', 'members'], 'only the three fields')
  t.alike(openAccountStore(dir, { readOnly: true }).linkStats(), want, 'a readOnly reopen gives the same answer')
  t.is(openAccountStore(dir, { now: c.now, maxMembers: 5 }).linkStats().maxMembers, 5, 'the cap is reported')

  const json = JSON.stringify(stats)
  t.absent(/[0-9a-f]{64}/i.test(json), 'no member key')
  t.absent(json.includes('@'), 'no e-mail')
  t.absent(json.includes('sub-'), 'no sub')
  for (const name of ['ana', 'beto', 'caio']) t.absent(json.includes(name), 'no username ' + name)
  t.absent(json.includes('T'), 'no time finer than a day')
})

test('linkStats: a custom dayOf buckets by another day (UTC-3 here)', async (t) => {
  const { c, iss, store } = setup(t)
  c.t = Date.parse('2026-10-02T01:00:00.000Z')
  await link(store, iss, memberKey(), 'dora')
  const dayOf = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10)
  t.alike(store.linkStats(dayOf).byDay, [['2026-10-01', 1]], 'counts on the UTC-3 day')
  t.alike(store.linkStats().byDay, [['2026-10-02', 1]], 'the default stays UTC')
})

test('a symlinked data dir is refused', (t) => {
  const root = tmpDir(t)
  const real = path.join(root, 'real')
  fs.mkdirSync(real)
  const link = path.join(root, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openAccountStore(link))
})

test('readOnly: no mkdir or chmod, reads the links, refuses every disk mutation', async (t) => {
  const { dir, iss, store } = setup(t)
  const member = memberKey()
  await link(store, iss, member, 'leitura')
  fs.chmodSync(dir, 0o750)

  const ro = openAccountStore(dir, { readOnly: true })
  t.is(fs.statSync(dir).mode & 0o777, 0o750, 'permissions untouched')
  t.alike(ro.exportLinks().map((l) => l.member), [member], 'links are readable')
  const row = ro.start({ member: memberKey(), username: 'outro_nome' })
  ro.reserve(row.id)
  ro.putGoogle(row.id, { sub: 'sub-ro', email: 'ro@example.test' })
  await rejects(t, ro.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'finish refused')
  await rejects(t, ro.rename(member, 'novo_nome', iss.kp, iss.cert), 'indisponivel', 'rename refused')

  const missing = path.join(path.dirname(dir), 'nao-existe')
  t.is(openAccountStore(missing, { readOnly: true }).exportLinks().length, 0, 'a missing dir reads as empty')
  t.absent(fs.existsSync(missing), 'and is not created')
})

test('starts naming a public key never evict the row that key signed', async (t) => {
  const { store, iss } = setup(t)
  const victim = memberKey()
  const signed = store.start({ member: victim, username: 'vitima' })
  store.reserve(signed.id)
  // Anyone can name the victim's (public) key in start(): these never touch
  // the row the victim already signed (the per-member cap drops bare rows).
  for (let i = 0; i < MAX_UNPROVEN_PER_MEMBER + 2; i++) store.start({ member: victim, username: 'outro' + i })
  t.ok(store.get(signed.id), 'the signed row survives the per-member cap')
  store.putGoogle(signed.id, { sub: 'sub-vitima', email: 'v@example.test' })
  const res = await store.finish(signed.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.is(res.cert.member, victim, 'the victim still completes the link')
})

test('contact and memberForSub: the moderation desk view of a link; status and lookup stay without e-mail or sub', async (t) => {
  const { store, iss } = setup(t)
  const member = memberKey()
  const other = memberKey()
  await link(store, iss, member, 'vera', 'sub-vera', 'vera@example.test')

  t.alike(store.contact(member), { email: 'vera@example.test', sub: 'sub-vera', username: 'vera' })
  t.alike(store.contact(member.toUpperCase()), { email: 'vera@example.test', sub: 'sub-vera', username: 'vera' }, 'any hex case')
  t.is(store.contact(other), null, 'an unlinked member has no contact')
  t.is(store.contact('nope'), null, 'not a key')
  t.is(store.memberForSub('sub-vera'), member)
  t.is(store.memberForSub('sub-other'), null)
  t.is(store.memberForSub('__proto__'), null, 'a prototype name is an ordinary key')
  t.is(store.memberForSub(42), null)

  const pub = JSON.stringify([store.status(member), store.lookup('vera')])
  t.absent(pub.includes('vera@example.test'), 'status/lookup: no e-mail')
  t.absent(pub.includes('sub-vera'), 'status/lookup: no sub')
})

function capped (t, opts) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const iss = issuer()
  const open = () => openAccountStore(dir, { now: c.now, ...opts })
  return { dir, c, iss, store: open(), open }
}

function claim (s, member, username, sub, email = 'm@example.test') {
  const row = s.start({ member, username })
  s.reserve(row.id)
  s.putGoogle(row.id, { sub, email })
  return row
}

test('member cap: two links fill maxMembers 2; a third start is lista-de-espera and holds no row', async (t) => {
  const { store, iss } = capped(t, { maxMembers: 2 })
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia')
  const c = memberKey()
  throwsCode(t, () => store.start({ member: c, username: 'cora' }), 'lista-de-espera', 'a new member waits')
  throwsCode(t, () => store.start({ member: c, username: 'cora' }), 'lista-de-espera', 'again: nothing was queued')
  throwsCode(t, () => store.start({ member: a, username: 'outro' }), 'conta-vinculada', 'a linked member still hears conta-vinculada')
  throwsCode(t, () => store.start({ member: c, username: 'alba' }), 'lista-de-espera', 'the cap answers before the name check')
  t.is(store.status(c).linked, false)
  t.is(store.status(a).linked, true, 'status unchanged at the cap')
  t.is(store.lookup('bia').member, b, 'lookup unchanged at the cap')
  t.is(store.exportLinks().length, 2)
})

test('member cap: linked members still rename and take the same-sub e-mail update path', async (t) => {
  const { store, iss, c } = capped(t, { maxMembers: 2 })
  const a = memberKey()
  // Two rows started before either finished (a double click).
  const r1 = claim(store, a, 'alba', 'sub-a', 'a@example.test')
  const r2 = claim(store, a, 'alba', 'sub-a', 'a2@example.test')
  const first = await store.finish(r1.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  await link(store, iss, memberKey(), 'bia')
  const again = await store.finish(r2.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.is(again.cert, first.cert, 'the stored cert, not a new link')
  t.is(store.contact(a).email, 'a2@example.test', 'the e-mail is updated at the cap')
  c.t += COOLDOWN_MS
  const renamed = await store.rename(a, 'albinha', iss.kp, iss.cert)
  t.is(renamed.record.username, 'albinha', 'rename at the cap')
  t.is(store.exportLinks().length, 2)
})

test('member cap: a finish that races past a full cap is lista-de-espera, writes nothing and drops its row', async (t) => {
  const { store, iss, c, dir } = capped(t, { maxMembers: 2 })
  const a = memberKey()
  await link(store, iss, a, 'alba')
  c.t += COOLDOWN_MS
  const late = memberKey()
  const row = claim(store, late, 'cora', 'sub-cora', 'cora@example.test')
  await rejects(t, store.rename(a, 'cora', iss.kp, iss.cert), 'nome-em-uso', 'the claimed row holds its name')
  await link(store, iss, memberKey(), 'bia')
  const onDisk = () => fs.readFileSync(path.join(dir, FILE), 'utf8') + fs.readFileSync(journalFile(dir), 'utf8')
  const before = onDisk()
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'lista-de-espera', 'the cap filled meanwhile')
  t.is(onDisk(), before, 'snapshot and journal untouched')
  t.absent(before.includes('sub-cora') || before.includes('cora@example.test'), 'nothing about the attempt on disk')
  t.is(store.get(row.id), null, 'the pending row is gone')
  t.is(store.memberForSub('sub-cora'), null)
  t.is(store.status(late).linked, false)
  const renamed = await store.rename(a, 'cora', iss.kp, iss.cert)
  t.is(renamed.record.username, 'cora', 'the name is free for another member')
})

test('member cap: isFull() is false without a cap, true at the cap; dropPending removes a row', async (t) => {
  const { store: open } = capped(t, {})
  t.is(open.isFull(), false, 'no cap: never full')
  const { store, iss } = capped(t, { maxMembers: 1 })
  t.is(store.isFull(), false, 'under the cap')
  const row = claim(store, memberKey(), 'cora', 'sub-cora', 'cora@example.test')
  await link(store, iss, memberKey(), 'alba')
  t.is(store.isFull(), true, 'at the cap')
  store.dropPending(row.id)
  t.is(store.get(row.id), null, 'the pending row is gone')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'expirado', 'nothing left to finish')
  store.dropPending('nao-existe')
  t.is(store.isFull(), true, 'dropping a row changes no link')
})

// A capped store whose pending table records every key it deletes. get()
// expires a row lazily on its own, so the sweep itself is only visible as
// the deletion it makes. The table is built while the store opens, so the
// global Map is swapped for that call only.
function sweptStore (t, opts) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const iss = issuer()
  const deleted = []
  const NativeMap = globalThis.Map
  globalThis.Map = class extends NativeMap {
    delete (key) {
      deleted.push(key)
      return super.delete(key)
    }
  }
  let store
  try {
    store = openAccountStore(dir, { now: c.now, ...opts })
  } finally {
    globalThis.Map = NativeMap
  }
  return { c, iss, store, deleted }
}

test('member cap: a refused start still expires pending rows abandoned before the cap filled', async (t) => {
  const { store, iss, c, deleted } = sweptStore(t, { maxMembers: 1 })
  const abandoned = store.start({ member: memberKey(), username: 'cora' })
  await link(store, iss, memberKey(), 'alba')
  c.t += PENDING_TTL_MS + 1
  deleted.length = 0
  throwsCode(t, () => store.start({ member: memberKey(), username: 'nova' }), 'lista-de-espera', 'the cap is full')
  t.ok(deleted.includes(abandoned.id), 'the refused start swept the expired row')
  t.is(store.get(abandoned.id), null)
})

test('member cap: a refused finish drops its own row and sweeps expired ones', async (t) => {
  const { store, iss, c, deleted } = sweptStore(t, { maxMembers: 1 })
  const abandoned = store.start({ member: memberKey(), username: 'cora' })
  c.t += PENDING_TTL_MS / 2
  const late = claim(store, memberKey(), 'bia', 'sub-bia', 'bia@example.test')
  await link(store, iss, memberKey(), 'alba')
  c.t += PENDING_TTL_MS / 2 + 1
  deleted.length = 0
  await rejects(t, store.finish(late.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'lista-de-espera', 'the cap filled meanwhile')
  t.ok(deleted.includes(late.id), 'its own row is dropped')
  t.ok(deleted.includes(abandoned.id), 'the expired row is swept too')
})

test('member cap: a reopened store counts the existing links; lowering the cap removes nobody', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const iss = issuer()
  const first = openAccountStore(dir, { now: c.now })
  const members = [memberKey(), memberKey(), memberKey()]
  for (let i = 0; i < members.length; i++) await link(first, iss, members[i], fillerName(i))
  const two = openAccountStore(dir, { now: c.now, maxMembers: 2 })
  throwsCode(t, () => two.start({ member: memberKey(), username: 'nova' }), 'lista-de-espera', 'three links over a cap of 2')
  for (const m of members) t.is(two.status(m).linked, true, 'every link stays')
  const three = openAccountStore(dir, { now: c.now, maxMembers: 3 })
  throwsCode(t, () => three.start({ member: memberKey(), username: 'nova' }), 'lista-de-espera', 'exactly at the cap')
  const four = openAccountStore(dir, { now: c.now, maxMembers: 4 })
  t.ok(four.start({ member: memberKey(), username: 'nova' }), 'room under a higher cap')
})

test('maxPending: the option replaces MAX_PENDING; defaults unchanged when options are omitted', async (t) => {
  const { store } = capped(t, { maxPending: 2 })
  for (let i = 0; i < 2; i++) claim(store, fillerMember(i), fillerName(i), 'sub-' + i)
  throwsCode(t, () => store.start({ member: memberKey(), username: 'extra' }), 'lotado', 'two claimed rows fill a table of 2')

  const { store: plain, iss } = setup(t)
  for (let i = 0; i < 5; i++) await link(plain, iss, memberKey(), fillerName(i))
  t.ok(plain.start({ member: memberKey(), username: 'semteto' }), 'no member cap by default')
  t.is(MAX_PENDING, 1000, 'default pending ceiling')
})

// The journal: directory.json is the snapshot, directory.journal.<id> the
// lines after it (the id the snapshot names), directory.hwm the high-water
// mark.

// The ids of every journal file in `dir`, sorted.
function journalIds (dir) {
  return fs.readdirSync(dir)
    .filter((n) => n.startsWith(JOURNAL_PREFIX))
    .map((n) => n.slice(JOURNAL_PREFIX.length))
    .filter((id) => /^[0-9a-f]{32}$/.test(id))
    .sort()
}

// The live journal: the one directory.json names, else the only journal file.
function journalFile (dir) {
  if (fs.existsSync(path.join(dir, FILE))) {
    const snap = readSnapshotFile(dir)
    if (snap.v === 2) return journalPath(dir, snap.journal)
  }
  const ids = journalIds(dir)
  if (ids.length !== 1) throw new Error('journals: ' + ids.join(','))
  return journalPath(dir, ids[0])
}

// The change lines, without the header ({ journal: <id> }, the first line).
function journalLines (dir) {
  const text = fs.readFileSync(journalFile(dir), 'utf8')
  const lines = text === '' ? [] : text.trim().split('\n').map((l) => JSON.parse(l))
  if (lines.length > 0) lines.shift()
  return lines
}

function journalHeader (dir) {
  return fs.readFileSync(journalFile(dir), 'utf8').split('\n')[0]
}

function readSnapshotFile (dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
}

function readHwmFile (dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, HWM), 'utf8'))
}

// A rw open leaves an orphan written within ORPHAN_GRACE_MS alone (a
// writer unaware that it lost the lock may still hold it): backdates every
// journal file's mtime so the next rw open removes the orphans.
function ageJournals (dir) {
  const t = (Date.now() - 2 * ORPHAN_GRACE_MS) / 1000
  for (const id of journalIds(dir)) fs.utimesSync(journalPath(dir, id), t, t)
}

// Counts the snapshot replacements (writeJsonAtomic renames onto FILE).
function countSnapshots (t, dir) {
  const file = path.join(dir, FILE)
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  const counter = { n: 0, fault: null }
  fs.renameSync = function (from, to) {
    if (to === file) {
      if (counter.fault !== null) throw Object.assign(new Error('simulado'), { code: counter.fault })
      counter.n++
    }
    return renameSync.call(fs, from, to)
  }
  return counter
}

// Distinct for every i (fillerMember pads with 'f', so 0xf and 0xff collide).
function journalMember (i) {
  return 'a' + i.toString(16).padStart(63, '0')
}

async function fill (s, iss, from, to) {
  for (let i = from; i < to; i++) await link(s, iss, journalMember(i), fillerName(i), 'sub-' + i)
}

test('journal: 300 finishes compact once into a new journal file; the compacted snapshot is readable on its own', async (t) => {
  const { store, iss, dir } = setup(t)
  const snapshots = countSnapshots(t, dir)
  await fill(store, iss, 0, 1)
  t.is(snapshots.n, 0, 'the open published the v 2 snapshot; the first change appends only')
  const first = journalFile(dir)
  t.absent(fs.existsSync(path.join(dir, HWM)), 'no high-water mark before the first compaction')
  await fill(store, iss, 1, 300)
  t.is(snapshots.n, 1, 'one compaction for the next 299 finishes')

  const disk = readSnapshotFile(dir)
  t.is(disk.v, 2, 'the journal is not empty: v 2')
  t.is(disk.seq, COMPACT_EVERY)
  t.is(Object.keys(disk.links).length, COMPACT_EVERY)
  t.not(journalFile(dir), first, 'the compaction created a new journal file')
  t.absent(fs.existsSync(first), 'and retired the previous one')
  t.alike(journalIds(dir), [disk.journal], 'the only journal is the one the snapshot names')
  t.alike(readHwmFile(dir), { seq: COMPACT_EVERY, journal: disk.journal, links: COMPACT_EVERY, names: COMPACT_EVERY }, 'the high-water mark follows the compaction, with the counts')
  t.is(fs.statSync(path.join(dir, HWM)).mode & 0o777, 0o600)
  const lines = journalLines(dir)
  t.is(lines.length, 300 - COMPACT_EVERY, 'the rest is in the journal')
  t.is(lines[0].seq, COMPACT_EVERY + 1)
  t.is(lines[0].op, 'link')

  const ro = openAccountStore(dir, { readOnly: true })
  t.is(ro.exportLinks().length, 300, 'snapshot plus journal')
  t.alike(ro.exportLinks(), store.exportLinks(), 'the export is unchanged, in the same order')
  const alone = path.join(tmpDir(t), 'alone')
  fs.mkdirSync(alone)
  fs.copyFileSync(path.join(dir, FILE), path.join(alone, FILE))
  t.exception(() => openAccountStore(alone, { readOnly: true }), /diretório de contas inválido/, 'a v 2 snapshot without its journal fails closed')
  fs.writeFileSync(journalPath(alone, disk.journal), journalHeader(dir) + '\n')
  t.is(openAccountStore(alone, { readOnly: true }).exportLinks().length, COMPACT_EVERY, 'the snapshot validates beside its header alone')
})

test('journal: a failed compaction keeps the journal and the old snapshot, removes the journal it started, and fails the change', async (t) => {
  const { store, iss, dir } = setup(t)
  await fill(store, iss, 0, COMPACT_EVERY)
  const snapshots = countSnapshots(t, dir)
  const before = fs.readFileSync(path.join(dir, FILE), 'utf8')
  const journal = journalFile(dir)
  const beforeLog = fs.readFileSync(journal, 'utf8')
  const late = memberKey()
  const row = claim(store, late, 'tardia', 'sub-tardia')

  snapshots.fault = 'EIO'
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'the compaction due before the append fails')
  snapshots.fault = null
  t.is(fs.readFileSync(path.join(dir, FILE), 'utf8'), before, 'old snapshot kept')
  t.is(fs.readFileSync(journal, 'utf8'), beforeLog, 'journal kept')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'the journal the failed compaction created is removed')
  t.alike(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left')
  t.is(store.status(late).linked, false, 'memory: no link')
  const ro = openAccountStore(dir, { readOnly: true })
  t.is(ro.status(late).linked, false, 'disk: no link')
  t.is(ro.exportLinks().length, COMPACT_EVERY, 'every earlier link is still read')

  const res = await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.is(res.cert.member, late, 'a retry compacts and links')
  t.is(journalLines(dir).length, 1)
  t.is(readSnapshotFile(dir).seq, COMPACT_EVERY)
  t.absent(fs.existsSync(journal), 'the previous journal is retired')
})

test('journal: one append and one fsync per sign-up, whatever the directory size', async (t) => {
  const { store, iss, dir } = setup(t)
  await fill(store, iss, 0, 2)
  const snapshots = countSnapshots(t, dir)
  const { fsyncSync, writeSync } = fs
  t.teardown(() => { fs.fsyncSync = fsyncSync; fs.writeSync = writeSync }, { force: true })
  let fsyncs = 0
  let writes = 0
  fs.fsyncSync = function (fd) { fsyncs++; return fsyncSync.call(fs, fd) }
  fs.writeSync = function (...args) { writes++; return writeSync.apply(fs, args) }
  const cost = async (i) => {
    fsyncs = 0
    writes = 0
    await fill(store, iss, i, i + 1)
    return [fsyncs, writes]
  }
  t.alike(await cost(2), [1, 1], 'small directory: one write, one fsync')
  t.alike(await cost(3), [1, 1])
  await fill(store, iss, 4, 120)
  t.alike(await cost(120), [1, 1], 'larger directory: the same')
  t.is(snapshots.n, 0, 'no snapshot rewritten')
})

test('journal: a readOnly open during the service sees the journal and writes nothing', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia')
  t.is(Object.keys(readSnapshotFile(dir).links).length, 0, 'both links are only in the journal')
  const listing = () => fs.readdirSync(dir).sort().map((n) => {
    const st = fs.statSync(path.join(dir, n))
    return [n, st.size, st.mtimeMs, st.mode, fs.readFileSync(path.join(dir, n), 'utf8')]
  })
  const before = listing()
  const ro = openAccountStore(dir, { readOnly: true })
  t.alike(ro.exportLinks().map((l) => l.member), [a, b], 'the journal is replayed')
  t.is(ro.lookup('bia').member, b)
  t.is(ro.restored, false)
  await ro.close()
  t.alike(listing(), before, 'no file written, created or chmodded, not even by close')
})

test('journal: a torn last line is ignored by readers and dropped by the next rw open', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia')
  const log = journalFile(dir)
  // A crash in the middle of the third append.
  fs.appendFileSync(log, '{"seq":3,"op":"link","member":"' + memberKey().slice(0, 20))
  const ro = openAccountStore(dir, { readOnly: true })
  t.alike(ro.exportLinks().map((l) => l.member), [a, b], 'the torn line is ignored')
  t.ok(fs.readFileSync(log, 'utf8').includes('"seq":3'), 'a reader leaves it in place')

  const rw = open()
  t.absent(fs.existsSync(log), 'the rw open retires that journal')
  t.alike(journalLines(dir), [], 'the new one is header-only')
  t.is(readSnapshotFile(dir).seq, 2, 'and folds the two complete lines into the snapshot')
  const c = memberKey()
  await link(rw, iss, c, 'cora')
  t.alike(journalLines(dir).map((l) => l.seq), [3], 'the next append starts on a line boundary')
  t.alike(openAccountStore(dir, { readOnly: true }).exportLinks().map((l) => l.member), [a, b, c])
})

test('journal: a damaged complete line or a line that breaks an invariant fails closed', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const log = journalFile(dir)
  const good = fs.readFileSync(log, 'utf8')
  const refused = (text, msg) => {
    fs.writeFileSync(log, text)
    t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, msg)
  }
  refused(good + 'lixo\n', 'garbage')
  const line = JSON.parse(good.trim().split('\n')[1])
  refused(good + JSON.stringify({ ...line, seq: 2 }) + '\n', 'the same member linked twice')
  refused(good + JSON.stringify({ ...line, seq: 2, member: memberKey() }) + '\n', 'the same sub and name for another member')
  refused(good + JSON.stringify({ seq: 3, op: 'email', member: a, email: 'x@example.test' }) + '\n', 'a gap in seq')
  refused(good + JSON.stringify({ seq: 2, op: 'rename', member: a, username: 'nova', usernameRecord: {}, usernameChangedAt: 'x', previous: 'outra' }) + '\n', 'a rename from a name not held')
  refused(good + JSON.stringify({ seq: 2, op: 'apagar', member: a }) + '\n', 'an unknown op')
  fs.writeFileSync(log, good)
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'alba', 'the intact journal reads again')
})

test('journal: a reader racing a compaction reads again and sees every link', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia')
  const file = path.join(dir, FILE)
  const old = fs.readFileSync(file, 'utf8')
  // The close runs between the reader's snapshot read and its journal
  // read: the reader holds the old snapshot (seq 0, naming a journal that
  // is gone).
  await store.close()
  t.alike(journalIds(dir), [], 'no journal after the close')
  const { readFileSync } = fs
  t.teardown(() => { fs.readFileSync = readFileSync }, { force: true })
  let reads = 0
  fs.readFileSync = function (p, ...rest) {
    if (p === file && reads++ === 0) return old
    return readFileSync.call(fs, p, ...rest)
  }
  const ro = openAccountStore(dir, { readOnly: true })
  t.ok(reads >= 4, 'the snapshot seq changed under the reader: read again')
  t.alike(ro.exportLinks().map((l) => l.member), [a, b], 'every link is seen')

  // A race that never settles is a damaged directory, never a partial one.
  reads = 0
  fs.readFileSync = function (p, ...rest) {
    if (p === file && reads++ % 2 === 0) return old
    return readFileSync.call(fs, p, ...rest)
  }
  t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/)
  t.is(reads, 8, 'one read and three retries')
})

test('journal: a snapshot that moved while the journals were read is read again, not reported as damage', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const file = path.join(dir, FILE)
  const old = fs.readFileSync(file, 'utf8')
  // A rw open compacts into a new journal and retires the old one; the
  // reader gets the old snapshot, which names the retired journal.
  const rw = open()
  t.absent(fs.existsSync(journalPath(dir, JSON.parse(old).journal)), 'the journal the old snapshot names is gone')
  const { readFileSync } = fs
  t.teardown(() => { fs.readFileSync = readFileSync }, { force: true })
  let snapReads = 0
  fs.readFileSync = function (p, ...rest) {
    if (p === file && snapReads++ === 0) return old
    return readFileSync.call(fs, p, ...rest)
  }
  const ro = openAccountStore(dir, { readOnly: true })
  t.alike(ro.exportLinks().map((l) => l.member), [a], 'read again and every link is seen')

  // Unparsable bytes in the named journal under a snapshot that does not
  // move are a damaged journal.
  fs.readFileSync = readFileSync
  await link(rw, iss, memberKey(), 'bia')
  fs.appendFileSync(journalFile(dir), '{"seq":99,"op":"li\n')
  t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/)
})

test('journal: the member cap counts the links replayed from the journal', async (t) => {
  const { store, iss, dir } = setup(t)
  await link(store, iss, memberKey(), 'alba')
  await link(store, iss, memberKey(), 'bia')
  t.is(Object.keys(readSnapshotFile(dir).links).length, 0, 'both links are only in the journal')
  const ro = openAccountStore(dir, { readOnly: true, maxMembers: 2 })
  throwsCode(t, () => ro.start({ member: memberKey(), username: 'cora' }), 'lista-de-espera', 'replayed links fill the cap')
  t.is(ro.isFull(), true)
  const rw = openAccountStore(dir, { maxMembers: 2 })
  throwsCode(t, () => rw.start({ member: memberKey(), username: 'cora' }), 'lista-de-espera', 'also after the rw open compacts')
})

test('journal: v 2 on disk while the journal is not empty; a clean close leaves a complete v 1, no journal and the hwm', async (t) => {
  const { store, iss, dir, open, c } = setup(t)
  t.is(readSnapshotFile(dir).v, 2, 'the open alone publishes a v 2 snapshot (the fence), which a previous build (v 1 only) refuses')
  t.is(readSnapshotFile(dir).seq, 0)
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'naming a fresh journal')
  t.alike(journalLines(dir), [], 'header-only')
  t.absent(fs.existsSync(path.join(dir, HWM)), 'no hwm before a compaction or a close')
  const a = memberKey()
  await link(store, iss, a, 'alba')
  t.is(readSnapshotFile(dir).v, 2)
  t.is(journalLines(dir).length, 1)
  c.t += COOLDOWN_MS
  await store.rename(a, 'albinha', iss.kp, iss.cert)

  await store.close()
  const disk = readSnapshotFile(dir)
  t.is(disk.v, 1, 'complete v 1 after close')
  t.is(disk.seq, 2)
  t.is(disk.links[a].username, 'albinha', 'with every journaled change')
  t.is(disk.usedNames.alba, a, 'and every used name')
  t.alike(journalIds(dir), [], 'no journal file beside it')
  t.is(readHwmFile(dir).seq, 2, 'the high-water mark is at the last change')
  t.is(store.status(a).username, 'albinha', 'reads still work after close')
  const row = claim(store, memberKey(), 'cora', 'sub-cora')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'mutations refused after close')
  await store.close()

  const again = open()
  t.is(readSnapshotFile(dir).v, 2, 'a rw open on the v 1 snapshot flips it to v 2 at once')
  t.is(readSnapshotFile(dir).seq, 2, 'at the same seq')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'naming a new header-only journal')
  t.is(readHwmFile(dir).seq, 2, 'the mark is unchanged')
  await link(again, iss, memberKey(), 'bia')
  t.alike(journalLines(dir).map((l) => l.seq), [3], 'the first append goes into it')
  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 2)
})

// Compaction crash safety: the previous journal is kept until the new
// snapshot names the new one; what a crash leaves behind opens with every
// change, and the next rw open removes the leftovers.

test('compaction: a crash before the snapshot rename keeps the old snapshot and journal; the header-only file it created is an orphan', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia')
  const file = path.join(dir, FILE)
  const journal = journalFile(dir)
  const before = fs.readFileSync(file, 'utf8')
  const beforeLog = fs.readFileSync(journal, 'utf8')
  const { renameSync, unlinkSync } = fs
  t.teardown(() => { fs.renameSync = renameSync; fs.unlinkSync = unlinkSync }, { force: true })
  // The process dies after the new journal is created and fsynced: the
  // rename never happens and nothing is cleaned up.
  fs.renameSync = function (from, to) {
    if (to === file) throw Object.assign(new Error('morto'), { code: 'EIO' })
    return renameSync.call(fs, from, to)
  }
  fs.unlinkSync = function (p) {
    if (path.basename(p).startsWith(JOURNAL_PREFIX)) return
    return unlinkSync.call(fs, p)
  }
  t.exception(() => open(), /morto/, 'the rw open compaction stops before the rename')
  fs.renameSync = renameSync
  fs.unlinkSync = unlinkSync
  t.is(fs.readFileSync(file, 'utf8'), before, 'the old snapshot is intact')
  t.is(fs.readFileSync(journal, 'utf8'), beforeLog, 'and its journal')
  const ids = journalIds(dir)
  t.is(ids.length, 2, 'beside the orphan the crash left')
  const orphan = ids.find((id) => journalPath(dir, id) !== journal)
  t.is(fs.readFileSync(journalPath(dir, orphan), 'utf8'), JSON.stringify({ journal: orphan }) + '\n', 'header only')
  t.alike(openAccountStore(dir, { readOnly: true }).exportLinks().map((l) => l.member), [a, b], 'readers see every change')

  ageJournals(dir)
  const rw = open()
  t.alike(rw.exportLinks().map((l) => l.member), [a, b])
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'the next rw open compacts and removes the orphan and the retired journal')
  t.is(readSnapshotFile(dir).seq, 2)
})

test('compaction: a crash after the snapshot rename and before the unlink leaves the old journal as an orphan that the next rw open removes', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia')
  const journal = journalFile(dir)
  const beforeLog = fs.readFileSync(journal, 'utf8')
  const { unlinkSync } = fs
  t.teardown(() => { fs.unlinkSync = unlinkSync }, { force: true })
  fs.unlinkSync = function (p) {
    if (p === journal) throw Object.assign(new Error('morto'), { code: 'EIO' })
    return unlinkSync.call(fs, p)
  }
  t.exception(() => open(), /morto/, 'the rw open compaction stops after the rename')
  fs.unlinkSync = unlinkSync
  const snap = readSnapshotFile(dir)
  t.is(snap.seq, 2, 'the new snapshot is installed')
  t.not(journalPath(dir, snap.journal), journal, 'and names the new journal')
  t.alike(journalLines(dir), [], 'which is header-only')
  t.is(fs.readFileSync(journal, 'utf8'), beforeLog, 'the old journal is untouched')
  t.absent(fs.existsSync(path.join(dir, HWM)), 'the hwm was not reached')
  t.alike(openAccountStore(dir, { readOnly: true }).exportLinks().map((l) => l.member), [a, b], 'readers skip the orphan (nothing past the snapshot)')

  // The stale writer's next change: its journal is no longer named.
  const row = claim(store, memberKey(), 'cora', 'sub-cora')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the old writer stops')
  t.is(fs.readFileSync(journal, 'utf8'), beforeLog, 'and wrote nothing')

  ageJournals(dir)
  const rw = open()
  t.alike(rw.exportLinks().map((l) => l.member), [a, b])
  t.not(readSnapshotFile(dir).journal, snap.journal, 'the next rw open fences: a new journal')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'the orphan and the retired journal are removed')
  const c = memberKey()
  await link(rw, iss, c, 'cora')
  t.alike(journalLines(dir).map((l) => l.seq), [3])
  t.alike(openAccountStore(dir, { readOnly: true }).exportLinks().map((l) => l.member), [a, b, c])
})

test('compaction: a failed hwm write after the unlink fails the change and leaves a directory that opens', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const hwm = path.join(dir, HWM)
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = function (from, to) {
    if (to === hwm) throw Object.assign(new Error('morto'), { code: 'EIO' })
    return renameSync.call(fs, from, to)
  }
  t.exception(() => open(), /morto/, 'the rw open compaction stops at the hwm')
  fs.renameSync = renameSync
  t.absent(fs.existsSync(hwm), 'no hwm')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'the old journal is already retired')
  t.alike(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left')
  const rw = open()
  t.is(rw.status(a).username, 'alba')
  await rw.close()
  t.is(readHwmFile(dir).seq, 1, 'the close writes it')
})

test('snapshot: a data dir fsync that fails after the snapshot rename is done again before the next change is acknowledged', async (t) => {
  const { store, iss, dir } = setup(t)
  // The compaction due before the next change renames a snapshot.
  await fill(store, iss, 0, COMPACT_EVERY)
  const previous = journalFile(dir)
  const file = path.join(dir, FILE)
  const { fsyncSync, renameSync } = fs
  t.teardown(() => { fs.fsyncSync = fsyncSync; fs.renameSync = renameSync }, { force: true })
  // Armed by the snapshot rename; the next directory fsync then fails.
  let armed = false
  let dirFsyncs = 0
  fs.renameSync = function (from, to) {
    const out = renameSync.call(fs, from, to)
    if (to === file) armed = true
    return out
  }
  fs.fsyncSync = function (fd) {
    if (fs.fstatSync(fd).isDirectory()) {
      dirFsyncs++
      if (armed) {
        armed = false
        throw Object.assign(new Error('simulado'), { code: 'EIO' })
      }
    }
    return fsyncSync.call(fs, fd)
  }

  const a = memberKey()
  const row = store.start({ member: a, username: 'joao' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: 'sub-joao', email: 'j@example.test' })
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'the change fails')
  t.is(readSnapshotFile(dir).seq, COMPACT_EVERY, 'the rename landed')
  t.alike(journalLines(dir), [], 'nothing appended to the new journal')
  t.ok(fs.existsSync(previous), 'the previous journal is not retired before the rename is durable (an orphan with nothing past the snapshot)')
  t.is(store.status(a).linked, false, 'nothing acknowledged')

  // The retry's own directory fsync fails too: still nothing appended.
  armed = true
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'the retry fails on the directory fsync')
  t.alike(journalLines(dir), [], 'before any append')
  t.is(store.status(a).linked, false)

  dirFsyncs = 0
  const res = await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.ok(res.cert, 'the next retry succeeds')
  t.is(dirFsyncs, 1, 'after fsyncing the data dir for the snapshot rename, without another snapshot')
  t.is(readSnapshotFile(dir).seq, COMPACT_EVERY, 'the same snapshot')
  t.alike(journalLines(dir).map((l) => l.seq), [COMPACT_EVERY + 1])
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'joao', 'the link is on disk')

  dirFsyncs = 0
  await link(store, iss, memberKey(), 'kira', 'sub-kira')
  t.is(dirFsyncs, 0, 'a later change does not repeat it')
})

// Journal binding, the writer guard and whole link records.

function refusedOpen (t, dir, msg) {
  t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, msg + ' (readOnly)')
  t.exception(() => openAccountStore(dir), /diretório de contas inválido/, msg + ' (rw)')
}

test('journal binding: directory.journal.<id> starts with a header carrying the id the v 2 snapshot names', async (t) => {
  const { store, iss, dir } = setup(t)
  t.is(JOURNAL_PREFIX, 'directory.journal.', 'no *.log rotation pattern matches it')
  await link(store, iss, memberKey(), 'alba')
  const header = JSON.parse(journalHeader(dir))
  t.alike(Object.keys(header), ['journal'])
  t.ok(/^[0-9a-f]{32}$/.test(header.journal), 'a random 16-byte hex id')
  t.is(readSnapshotFile(dir).journal, header.journal, 'the snapshot names it')
  t.alike(journalIds(dir), [header.journal], 'and the file is named by it')
  await store.close()
  t.absent('journal' in readSnapshotFile(dir), 'a v 1 snapshot names no journal')
  t.alike(journalIds(dir), [], 'and has none')
})

test('journal binding: a v 2 snapshot whose journal is missing, empty, headerless or foreign fails closed', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, memberKey(), 'bia')
  const journal = journalFile(dir)
  const good = fs.readFileSync(journal, 'utf8')
  const [header, ...rest] = good.trim().split('\n')

  fs.unlinkSync(journal)
  refusedOpen(t, dir, 'missing')
  t.absent(fs.existsSync(journal), 'the refused rw open created nothing')
  t.alike(journalIds(dir), [], 'nothing at all')
  fs.writeFileSync(journal, '')
  refusedOpen(t, dir, 'empty')
  fs.writeFileSync(journal, rest.join('\n') + '\n')
  refusedOpen(t, dir, 'no header')
  fs.writeFileSync(journal, JSON.stringify({ journal: 'f'.repeat(32) }) + '\n' + rest.join('\n') + '\n')
  refusedOpen(t, dir, 'another journal id')
  fs.writeFileSync(journal, JSON.stringify({ journal: 'f'.repeat(32) }) + '\n')
  refusedOpen(t, dir, 'another journal, header only')
  fs.writeFileSync(journal, JSON.stringify({ journal: JSON.parse(header).journal, extra: 1 }) + '\n' + rest.join('\n') + '\n')
  refusedOpen(t, dir, 'a header with more than the id')
  // The named journal moved to another id's name: the snapshot's name is
  // what counts, not the content.
  fs.writeFileSync(journal, good)
  fs.renameSync(journal, journalPath(dir, 'e'.repeat(32)))
  refusedOpen(t, dir, 'the journal under another file name')
  fs.renameSync(journalPath(dir, 'e'.repeat(32)), journal)

  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 2, 'the bound journal reads again')
})

test('journal binding: a v 1 snapshot refuses a journal line past it; an empty, header-only or torn-header orphan opens and is removed', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const journal = journalFile(dir)
  const bound = fs.readFileSync(journal, 'utf8')
  const [header] = bound.trim().split('\n')
  await store.close()
  t.is(readSnapshotFile(dir).v, 1)
  t.absent(fs.existsSync(journal), 'the close removed the journal')

  fs.writeFileSync(journal, bound.replace(/"seq":1/, '"seq":2').replace(/"username":"alba"/, '"username":"bia"').replace(new RegExp(a, 'g'), memberKey()))
  refusedOpen(t, dir, 'a change line past the snapshot beside a v 1 snapshot')
  t.ok(fs.existsSync(journal), 'the refused rw open removed nothing')

  // A crash between close's v 1 write and its unlink: header only.
  fs.writeFileSync(journal, header + '\n')
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'alba', 'header-only beside v 1 opens')
  t.ok(fs.existsSync(journal), 'a reader leaves it')
  ageJournals(dir)
  const rw = open()
  t.absent(fs.existsSync(journal), 'the rw open removes the orphan')
  await link(rw, iss, memberKey(), 'bia')
  t.not(readSnapshotFile(dir).journal, JSON.parse(header).journal, 'the next start gets a new id')
  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 2)
  await rw.close()
  t.alike(journalIds(dir), [])

  // A crash while a header was written: a torn header beside v 1.
  fs.writeFileSync(journal, header.slice(0, 10))
  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 2, 'a torn header beside v 1 opens')
  ageJournals(dir)
  const again = open()
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'the rw open removes it (and starts its own journal)')
  await link(again, iss, memberKey(), 'cora')
  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 3)
})

test('orphans: a journal file no snapshot names is left by readers, removed by a rw open after a snapshot write, and refused with a line past the snapshot', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const journal = journalFile(dir)
  const lineText = fs.readFileSync(journal, 'utf8').trim().split('\n')[1]
  const orphanId = 'b'.repeat(32)
  const orphan = journalPath(dir, orphanId)
  const file = path.join(dir, FILE)

  // A line past the snapshot that the named journal does not hold (the
  // same seq, another member): an acknowledged change no snapshot names.
  const foreignLine = { ...JSON.parse(lineText), member: memberKey() }
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n' + JSON.stringify(foreignLine) + '\n')
  refusedOpen(t, dir, 'an orphan with a line past the snapshot (seq 1 over a snapshot at 0)')
  t.ok(fs.existsSync(orphan), 'kept for the operator')

  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n')
  const foreign = path.join(dir, 'directory.journal.not-an-id')
  fs.writeFileSync(foreign, 'x')
  const ro = openAccountStore(dir, { readOnly: true })
  t.alike(ro.exportLinks().map((l) => l.member), [a], 'a header-only orphan is ignored')
  t.ok(fs.existsSync(orphan), 'and left by a reader')

  const snapIno = fs.statSync(file).ino
  ageJournals(dir)
  const rw = open()
  t.alike(rw.exportLinks().map((l) => l.member), [a])
  t.absent(fs.existsSync(orphan), 'removed by the rw open')
  t.absent(fs.existsSync(journal), 'with the journal the open compaction retired')
  t.ok(fs.existsSync(foreign), 'a file that is not a journal of ours is left alone')
  t.not(fs.statSync(file).ino, snapIno, 'after a snapshot write')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal])

  // With no line to compact, the rw open still publishes a snapshot (the
  // fence) before removing an orphan, so a stalled writer about to name it
  // is fenced first (its guard compares the snapshot file).
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n')
  ageJournals(dir)
  const before = fs.statSync(file).ino
  open()
  t.absent(fs.existsSync(orphan), 'removed')
  t.not(fs.statSync(file).ino, before, 'after a snapshot write of the same content')
  t.is(readSnapshotFile(dir).seq, 1)
})

test('orphans: a rw open keeps an orphan younger than the lock\'s staleness plus a heartbeat, and removes it once it is older', async (t) => {
  const { store, iss, dir, open } = setup(t)
  t.is(ORPHAN_GRACE_MS, LOCK_STALE_MS + LOCK_HEARTBEAT_MS, 'the grace mirrors the lock constants of server.js')
  await link(store, iss, memberKey(), 'alba')
  const orphanId = 'b'.repeat(32)
  const orphan = journalPath(dir, orphanId)
  // A writer that has not noticed it lost the lock may still hold a file
  // written moments ago: left for a later open.
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n')
  const rw = open()
  t.ok(fs.existsSync(orphan), 'a young orphan is kept')
  t.is(rw.exportLinks().length, 1)
  t.ok(fs.existsSync(journalPath(dir, readSnapshotFile(dir).journal)), 'the named journal is there')
  const t0 = (Date.now() - ORPHAN_GRACE_MS + 5000) / 1000
  fs.utimesSync(orphan, t0, t0)
  open()
  t.ok(fs.existsSync(orphan), 'still kept 5 s short of the grace')
  ageJournals(dir)
  open()
  t.absent(fs.existsSync(orphan), 'removed once older than the grace')
})

test('orphans: a snapshot that changed under the store right before the sweep marks it unavailable instead of unlinking', async (t) => {
  const { store, iss, dir, open } = setup(t)
  await link(store, iss, memberKey(), 'alba')
  const file = path.join(dir, FILE)
  const hwm = path.join(dir, HWM)
  const orphanId = 'b'.repeat(32)
  const orphan = journalPath(dir, orphanId)
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n')
  ageJournals(dir)
  // Another writer replaces directory.json after this open's hwm write
  // (its last write before the sweep) and before the orphan's unlink.
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  let replaced = 0
  let orphanSeen = 0
  fs.renameSync = function (from, to) {
    const out = renameSync.call(fs, from, to)
    if (to === hwm) {
      replaced++
      if (fs.existsSync(orphan)) orphanSeen++
      fs.writeFileSync(file + '.novo', fs.readFileSync(file))
      renameSync.call(fs, file + '.novo', file)
    }
    return out
  }
  try {
    open()
    t.fail('opened')
  } catch (err) {
    t.is(err.code, 'indisponivel', 'the open gives up after its retries')
  }
  fs.renameSync = renameSync
  t.is(replaced, 4, 'one attempt and three retries, each fenced before the sweep')
  t.is(orphanSeen, 4, 'the orphan was never unlinked')
  t.ok(fs.existsSync(orphan), 'and is still there')
  t.alike(journalIds(dir), [orphanId, readSnapshotFile(dir).journal].sort(), 'beside the named journal only')
  const rw = open()
  t.is(rw.exportLinks().length, 1, 'opens once nothing moves the snapshot')
  t.absent(fs.existsSync(orphan), 'and removes the orphan')
})

test('writer guard: a journal truncated, replaced or deleted behind the writer makes the next mutation indisponivel, writing nothing', async (t) => {
  const cases = {
    truncated: (journal) => fs.truncateSync(journal, 0),
    replaced: (journal) => {
      const tmp = journal + '.novo'
      fs.writeFileSync(tmp, fs.readFileSync(journal))
      fs.renameSync(tmp, journal)
    },
    deleted: (journal) => fs.unlinkSync(journal),
    appended: (journal) => fs.appendFileSync(journal, '{"seq":'),
    'snapshot replaced': (journal, dir) => {
      const file = path.join(dir, FILE)
      fs.writeFileSync(file + '.novo', fs.readFileSync(file))
      fs.renameSync(file + '.novo', file)
    }
  }
  for (const [name, change] of Object.entries(cases)) {
    const { store, iss, dir, c } = setup(t)
    const a = memberKey()
    await link(store, iss, a, 'alba')
    const journal = journalFile(dir)
    change(journal, dir)
    const after = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : null
    const row = claim(store, memberKey(), 'bia', 'sub-bia')
    await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', name + ': finish refused')
    c.t += COOLDOWN_MS
    await rejects(t, store.rename(a, 'albinha', iss.kp, iss.cert), 'indisponivel', name + ': every later mutation refused')
    t.is(fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : null, after, name + ': nothing written')
    t.is(store.status(a).username, 'alba', name + ': reads keep working')
    await rejects(t, store.close(), 'indisponivel', name + ': close reports the v 2 directory it cannot finish')
    t.is(readSnapshotFile(dir).v, 2, name + ': close writes nothing either')
  }
})

test('writer guard: a takeover that compacts into a new journal and appends a line of the same length stops the stale writer before any write', async (t) => {
  const { store: stale, iss, dir, open } = setup(t)
  const a = memberKey()
  await link(stale, iss, a, 'alba')
  const old = journalFile(dir)
  const oldSize = fs.statSync(old).size

  // The lock went stale and another process took it over: its rw open
  // compacts (new journal, new id, the old file unlinked) and it links a
  // member whose line is as long as the one the stale writer wrote.
  const taker = open()
  t.absent(fs.existsSync(old), 'the stale writer\'s journal is unlinked')
  const b = memberKey()
  await link(taker, iss, b, 'cora')
  const live = journalFile(dir)
  t.is(fs.statSync(live).size, oldSize, 'the live journal has exactly the size the stale writer remembers')
  const liveBefore = fs.readFileSync(live, 'utf8')

  const row = claim(stale, memberKey(), 'dora', 'sub-dora')
  await rejects(t, stale.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the stale writer stops')
  t.is(fs.readFileSync(live, 'utf8'), liveBefore, 'and wrote nothing into the live journal')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'no other journal appeared')
  await rejects(t, stale.close(), 'indisponivel', 'its close writes nothing')

  const again = openAccountStore(dir, { readOnly: true })
  t.alike(again.exportLinks().map((l) => l.member), [a, b], 'the directory holds the takeover\'s state')
  t.is(again.status(a).username, 'alba')
  t.is(again.lookup('dora'), null)
  await taker.close()
  t.alike(open().exportLinks().map((l) => l.member), [a, b], 'and opens')
})

test('writer guard: a line a stale writer lands in the previous journal while a rw open compacts is folded into the new journal', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia', 'sub-bia')
  const journal = journalFile(dir)
  const second = journalLines(dir)[1]
  const late = memberKey()
  const staleLine = { ...second, seq: 3, member: late, link: { ...second.link, sub: 'sub-late', username: 'cora' } }

  // The old writer (stalled past the lock's staleness) appends an
  // acknowledged line right after the new writer's snapshot rename: its
  // guard passed before the rename, its write lands in the file about to
  // be retired.
  const file = path.join(dir, FILE)
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  let renames = 0
  fs.renameSync = function (from, to) {
    const out = renameSync.call(fs, from, to)
    if (to === file && renames++ === 0) fs.appendFileSync(journal, JSON.stringify(staleLine) + '\n')
    return out
  }
  const rw = open()
  fs.renameSync = renameSync
  t.is(renames, 1, 'one snapshot write')
  t.is(rw.status(late).username, 'cora', 'the late line is kept')
  t.is(readSnapshotFile(dir).seq, 2, 'the snapshot holds the two lines read')
  t.alike(journalLines(dir).map((l) => l.seq), [3], 'the late line is in the new journal')
  t.absent(fs.existsSync(journal), 'the previous journal is retired')
  t.is(readHwmFile(dir).seq, 3, 'the hwm counts it')
  throwsCode(t, () => rw.start({ member: memberKey(), username: 'cora' }), 'nome-em-uso', 'the name is never reissued')

  // The old writer's next change sees a journal it did not write.
  const old = claim(store, memberKey(), 'dora', 'sub-dora')
  await rejects(t, store.finish(old.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the stale writer stops')
  t.alike(journalLines(dir).map((l) => l.seq), [3], 'and wrote nothing')
  t.alike(openAccountStore(dir, { readOnly: true }).exportLinks().map((l) => l.member), [a, b, late])
})

test('writer guard: a torn byte in the retired journal is dropped; an unparsable line there fails closed and keeps the file', async (t) => {
  const { store, iss, dir, open } = setup(t)
  await link(store, iss, memberKey(), 'alba')
  const journal = journalFile(dir)
  const file = path.join(dir, FILE)
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  // Landed in the journal being retired, right after the snapshot rename.
  let target = journal
  let tail = ' '
  fs.renameSync = function (from, to) {
    const out = renameSync.call(fs, from, to)
    if (to === file) fs.appendFileSync(target, tail)
    return out
  }
  const rw = open()
  t.is(rw.exportLinks().length, 1)
  t.absent(fs.existsSync(journal), 'a torn byte (a write cut short, never acknowledged) goes with the retired file')
  t.alike(journalLines(dir), [])

  // A complete line that does not parse.
  await link(rw, iss, memberKey(), 'bia')
  target = journalFile(dir)
  tail = 'lixo\n'
  t.exception(() => open(), /diretório de contas inválido/, 'the open fails')
  fs.renameSync = renameSync
  t.ok(fs.existsSync(target), 'the file is kept')
  t.not(readSnapshotFile(dir).journal, path.basename(target).slice(JOURNAL_PREFIX.length), 'beside the new snapshot')
  refusedOpen(t, dir, 'an orphan that does not parse')
  fs.unlinkSync(target)
  t.is(open().exportLinks().length, 2, 'opens again once the operator removed it')
})

test('journal: every rw open replaces the journal with a fresh 0600 one, a header-only journal too; a readOnly open never chmods', async (t) => {
  const { store, iss, dir, open } = setup(t)
  await link(store, iss, memberKey(), 'alba')
  fs.chmodSync(journalFile(dir), 0o644)
  const first = journalFile(dir)
  const rw = open()
  t.not(journalFile(dir), first, 'the open compaction created a new journal')
  t.is(fs.statSync(journalFile(dir)).mode & 0o777, 0o600)
  fs.chmodSync(journalFile(dir), 0o644)
  const headerOnly = journalFile(dir)
  t.alike(journalLines(dir), [])
  const again = open()
  t.not(journalFile(dir), headerOnly, 'a header-only journal is replaced by the open too (the fence)')
  t.absent(fs.existsSync(headerOnly), 'and retired')
  t.is(fs.statSync(journalFile(dir)).mode & 0o777, 0o600)
  await link(again, iss, memberKey(), 'bia')
  fs.chmodSync(journalFile(dir), 0o644)
  openAccountStore(dir, { readOnly: true })
  t.is(fs.statSync(journalFile(dir)).mode & 0o777, 0o644, 'a readOnly open never chmods')
  await rejects(t, rw.close(), 'indisponivel', 'the first store is stale by now')
})

test('writer guard: a takeover in the header-only state (right after an open or a compaction) fences the stale writer before any write', async (t) => {
  // The state right after every rw open (on an empty dir, a v 1 or a v 2
  // snapshot): a snapshot naming a header-only journal, no orphans. A
  // takeover that wrote nothing here would share the snapshot inode and
  // the journal with the stale writer, whose guard would then pass.
  for (const [name, prepare] of Object.entries({
    'after the first open': async () => null,
    'after an open on a v 1 snapshot': async (s, iss, open) => {
      await link(s, iss, memberKey(), 'alba')
      await s.close()
      return open()
    },
    'after an open on a v 2 snapshot': async (s, iss, open) => {
      await link(s, iss, memberKey(), 'alba')
      return open()
    }
  })) {
    const { store: first, iss, dir, open } = setup(t)
    const stale = (await prepare(first, iss, open)) || first
    const file = path.join(dir, FILE)
    t.is(readSnapshotFile(dir).v, 2, name + ': a v 2 snapshot')
    const old = journalFile(dir)
    t.alike(journalLines(dir), [], name + ': naming a header-only journal')
    const oldIno = fs.statSync(file).ino

    const taker = open()
    t.absent(fs.existsSync(old), name + ': the stale writer\'s journal is unlinked by the takeover')
    t.not(fs.statSync(file).ino, oldIno, name + ': the snapshot inode changed')
    const live = journalFile(dir)
    const liveBefore = fs.readFileSync(live, 'utf8')

    const d = memberKey()
    const row = claim(stale, d, 'dora', 'sub-dora')
    await rejects(t, stale.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', name + ': the stale writer stops')
    t.is(stale.status(d).linked, false, name + ': nothing acknowledged')
    t.is(fs.readFileSync(live, 'utf8'), liveBefore, name + ': nothing written into the live journal')
    t.alike(journalIds(dir), [readSnapshotFile(dir).journal], name + ': no other journal appeared')
    await rejects(t, stale.close(), 'indisponivel', name + ': its close writes nothing')

    await link(taker, iss, memberKey(), 'dora')
    t.not(openAccountStore(dir, { readOnly: true }).lookup('dora').member, d, name + ': the name is issued once, by the new writer')
  }
})

test('writer guard: a line that lands in a journal unlinked, or under a snapshot replaced, between the guard and the write is not acknowledged', async (t) => {
  const { store, iss, dir, c } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const journal = journalFile(dir)
  const { writeSync } = fs
  t.teardown(() => { fs.writeSync = writeSync }, { force: true })
  // The takeover's unlink lands after the guard passed and before the
  // write: the write and its fsync reach an inode with nlink 0.
  fs.writeSync = function (fd, buf, ...rest) {
    fs.writeSync = writeSync
    fs.unlinkSync(journal)
    return writeSync.call(fs, fd, buf, ...rest)
  }
  const b = memberKey()
  const row = claim(store, b, 'bia', 'sub-bia')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the re-guard after the fsync refuses the change')
  fs.writeSync = writeSync
  t.is(store.status(b).linked, false, 'never adopted')
  t.is(store.lookup('bia'), null)
  t.absent(fs.existsSync(journal))
  c.t += COOLDOWN_MS
  await rejects(t, store.rename(a, 'albinha', iss.kp, iss.cert), 'indisponivel', 'the store is unavailable')

  // The snapshot replaced in the same window: the line is on disk (a
  // takeover folds it), but this store never acknowledges it.
  const { store: other, iss: iss2, dir: dir2 } = setup(t)
  await link(other, iss2, memberKey(), 'alba')
  const file = path.join(dir2, FILE)
  fs.writeSync = function (fd, buf, ...rest) {
    fs.writeSync = writeSync
    fs.writeFileSync(file + '.novo', fs.readFileSync(file))
    fs.renameSync(file + '.novo', file)
    return writeSync.call(fs, fd, buf, ...rest)
  }
  const d = memberKey()
  const row2 = claim(other, d, 'dora', 'sub-dora')
  await rejects(t, other.finish(row2.id, { signature: SIG }, iss2.kp, iss2.cert, iss2.association), 'indisponivel', 'refused')
  fs.writeSync = writeSync
  t.is(other.status(d).linked, false, 'never adopted here')
  t.is(openAccountStore(dir2, { readOnly: true }).status(d).username, 'dora', 'the line is on disk for the writer that owns the directory now')
})

test('orphans: a crash after retire() folded the late lines and before its unlink leaves an orphan whose lines past the snapshot are in the named journal; it opens', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, b, 'bia', 'sub-bia')
  const journal = journalFile(dir)
  const second = journalLines(dir)[1]
  const late = memberKey()
  const staleLine = { ...second, seq: 3, member: late, link: { ...second.link, sub: 'sub-late', username: 'cora' } }
  const file = path.join(dir, FILE)
  const { renameSync, unlinkSync } = fs
  t.teardown(() => { fs.renameSync = renameSync; fs.unlinkSync = unlinkSync }, { force: true })
  // A stale writer lands a line right after the snapshot rename (folded
  // by retire()), and the process dies at the unlink that follows.
  fs.renameSync = function (from, to) {
    const out = renameSync.call(fs, from, to)
    if (to === file) fs.appendFileSync(journal, JSON.stringify(staleLine) + '\n')
    return out
  }
  fs.unlinkSync = function (p) {
    if (p === journal) throw Object.assign(new Error('morto'), { code: 'EIO' })
    return unlinkSync.call(fs, p)
  }
  t.exception(() => open(), /morto/)
  fs.renameSync = renameSync
  fs.unlinkSync = unlinkSync
  const snap = readSnapshotFile(dir)
  t.is(snap.seq, 2)
  t.alike(journalLines(dir).map((l) => l.seq), [3], 'the late line is in the named journal')
  t.ok(fs.existsSync(journal), 'the previous journal is an orphan')
  t.alike(JSON.parse(fs.readFileSync(journal, 'utf8').trim().split('\n').pop()), staleLine, 'with the same line past the snapshot')

  const ro = openAccountStore(dir, { readOnly: true })
  t.alike(ro.exportLinks().map((l) => l.member), [a, b, late], 'an identical line in the named journal is not a lost change')
  t.is(ro.lookup('cora').member, late)
  ageJournals(dir)
  const rw = open()
  t.alike(rw.exportLinks().map((l) => l.member), [a, b, late])
  t.absent(fs.existsSync(journal), 'the next rw open removes the orphan')
  throwsCode(t, () => rw.start({ member: memberKey(), username: 'cora' }), 'nome-em-uso')

  // A line past the snapshot that differs from the named journal's, or that
  // it does not hold, is still a lost change.
  const orphanId = 'b'.repeat(32)
  const orphan = journalPath(dir, orphanId)
  const current = readSnapshotFile(dir).seq
  await link(rw, iss, memberKey(), 'dina', 'sub-dina')
  const theirs = JSON.parse(fs.readFileSync(journalFile(dir), 'utf8').trim().split('\n').pop())
  t.is(theirs.seq, current + 1)
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n' + JSON.stringify({ ...theirs, link: { ...theirs.link, email: 'outro@example.test' } }) + '\n')
  refusedOpen(t, dir, 'an orphan line that differs from the named journal\'s at the same seq')
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n' + JSON.stringify({ ...theirs, seq: theirs.seq + 1, member: memberKey(), link: { ...theirs.link, sub: 'sub-y', username: 'elsa' } }) + '\n')
  refusedOpen(t, dir, 'an orphan line the named journal does not hold')
  fs.writeFileSync(orphan, JSON.stringify({ journal: orphanId }) + '\n' + JSON.stringify(theirs) + '\n')
  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 4, 'the identical line opens')
})

test('whole link records: a link, rename or snapshot record missing a field fails closed at open', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const journal = journalFile(dir)
  const good = fs.readFileSync(journal, 'utf8')
  const line = JSON.parse(good.trim().split('\n')[1])
  const other = (patch) => JSON.stringify({ ...line, seq: 2, member: memberKey(), link: { ...line.link, sub: 'sub-outra', username: 'outra', ...patch } }) + '\n'
  const refused = (text, msg) => {
    fs.writeFileSync(journal, text)
    refusedOpen(t, dir, msg)
  }
  fs.writeFileSync(journal, good + other({}))
  t.is(openAccountStore(dir, { readOnly: true }).exportLinks().length, 2, 'a whole record opens')
  refused(good + other({ usernameChangedAt: 'nao-e-data' }), 'an unparsable usernameChangedAt')
  refused(good + other({ usernameChangedAt: 123 }), 'a numeric usernameChangedAt')
  refused(good + other({ linkedAt: undefined }), 'no linkedAt')
  refused(good + other({ linkedAt: 'ontem' }), 'an unparsable linkedAt')
  refused(good + other({ email: null }), 'no e-mail')
  refused(good + other({ cert: 'x' }), 'a cert that is not an object')
  refused(good + other({ usernameRecord: [] }), 'a usernameRecord that is an array')
  const rename = { seq: 2, op: 'rename', member: a, username: 'nova', usernameRecord: line.link.usernameRecord, previous: 'alba' }
  fs.writeFileSync(journal, good + JSON.stringify({ ...rename, usernameChangedAt: line.link.usernameChangedAt }) + '\n')
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'nova', 'a whole rename opens')
  refused(good + JSON.stringify({ ...rename, usernameChangedAt: 'x' }) + '\n', 'a rename with an unparsable usernameChangedAt')
  refused(good + JSON.stringify({ seq: 2, op: 'email', member: a, email: 7 }) + '\n', 'an e-mail change that is not a string')

  fs.writeFileSync(journal, good)
  await store.close()
  const file = path.join(dir, FILE)
  const snap = readSnapshotFile(dir)
  const bad = (patch, msg) => {
    fs.writeFileSync(file, JSON.stringify({ ...snap, links: { [a]: { ...snap.links[a], ...patch } } }))
    refusedOpen(t, dir, 'snapshot: ' + msg)
  }
  bad({ usernameChangedAt: 'x' }, 'an unparsable usernameChangedAt')
  bad({ linkedAt: undefined }, 'no linkedAt')
  bad({ cert: null }, 'no cert')
  fs.writeFileSync(file, JSON.stringify({ ...snap, links: { [a.toUpperCase()]: snap.links[a] } }))
  refusedOpen(t, dir, 'snapshot: a member key that is not lowercase hex')
  fs.writeFileSync(file, JSON.stringify(snap))
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'alba', 'the intact snapshot reads again')
})

test('fail(): the store refuses every mutation at once; reads keep working', async (t) => {
  const { store, iss, dir, c } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const journal = journalFile(dir)
  const before = fs.readFileSync(journal, 'utf8')
  const row = claim(store, memberKey(), 'bia', 'sub-bia')
  store.fail()
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'finish refused')
  c.t += COOLDOWN_MS
  await rejects(t, store.rename(a, 'albinha', iss.kp, iss.cert), 'indisponivel', 'rename refused')
  await rejects(t, store.close(), 'indisponivel', 'close reports that it could not finish')
  t.is(fs.readFileSync(journal, 'utf8'), before, 'nothing written, not even by close')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal])
  t.is(readSnapshotFile(dir).v, 2)
  t.is(store.status(a).username, 'alba', 'reads keep working')
})

test('close: a failed v 1 write rejects, leaves the store open, and a retry finishes it', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  const snapshots = countSnapshots(t, dir)
  snapshots.fault = 'ENOSPC'
  await rejects(t, store.close(), 'ENOSPC', 'the failed close rejects')
  snapshots.fault = null
  t.is(readSnapshotFile(dir).v, 2, 'still v 2 on disk')
  t.alike(journalIds(dir), [readSnapshotFile(dir).journal], 'beside its journal')
  t.absent(fs.existsSync(path.join(dir, HWM)), 'the close failed at its compaction, before the hwm')
  await store.close()
  t.is(readSnapshotFile(dir).v, 1, 'the retry writes the complete v 1')
  t.alike(journalIds(dir), [], 'and removes the journal')
  t.is(readHwmFile(dir).seq, 1, 'with the hwm')
  t.is(store.status(a).username, 'alba')
  const row = claim(store, memberKey(), 'bia', 'sub-bia')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'closed now')
  await store.close()
  await openAccountStore(dir, { readOnly: true }).close()
})

test('resync: a torn tail is cut only while the journal is still the file and the size it read', async (t) => {
  for (const [name, change] of Object.entries({
    grown: (journal) => fs.appendFileSync(journal, 'mais'),
    replaced: (journal) => {
      const tmp = journal + '.novo'
      fs.writeFileSync(tmp, fs.readFileSync(journal))
      fs.renameSync(tmp, journal)
    }
  })) {
    const { store, iss, dir } = setup(t)
    await link(store, iss, memberKey(), 'alba')
    const journal = journalFile(dir)
    const row = claim(store, memberKey(), 'bia', 'sub-bia')
    // The append writes half its line and fails (resync runs); between
    // resync's read and its truncation the journal changes behind it.
    const { writeSync, readFileSync } = fs
    t.teardown(() => { fs.writeSync = writeSync; fs.readFileSync = readFileSync }, { force: true })
    let armed = false
    fs.writeSync = (fd, buf, off, len) => {
      fs.writeSync = writeSync
      writeSync.call(fs, fd, buf, off, Math.floor(len / 2))
      armed = true
      throw Object.assign(new Error('killed'), { code: 'EIO' })
    }
    fs.readFileSync = function (p, ...rest) {
      const out = readFileSync.call(fs, p, ...rest)
      if (armed && p === journal) {
        armed = false
        change(journal)
      }
      return out
    }
    await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', name + ': the append fails')
    fs.writeSync = writeSync
    fs.readFileSync = readFileSync
    const after = fs.readFileSync(journal, 'utf8')
    if (name === 'grown') t.ok(after.endsWith('mais'), name + ': nothing cut')
    await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', name + ': the store is unavailable')
    t.is(fs.readFileSync(journal, 'utf8'), after, name + ': and writes nothing')
  }
})

test('snapshot indexes: bySub, byUsername and usedNames that disagree with the links fail closed', async (t) => {
  const { store, iss, dir, c, open } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba', 'sub-alba')
  await link(store, iss, b, 'bia', 'sub-bia')
  c.t += COOLDOWN_MS
  await store.rename(a, 'albinha', iss.kp, iss.cert)
  await store.close()
  const file = path.join(dir, FILE)
  const snap = readSnapshotFile(dir)
  t.is(snap.usedNames.alba, a, 'the past name stays in usedNames')
  const without = (map, key) => {
    const out = { ...map }
    delete out[key]
    return out
  }
  const bad = (patch, msg) => {
    fs.writeFileSync(file, JSON.stringify({ ...snap, ...patch }))
    refusedOpen(t, dir, 'snapshot: ' + msg)
  }
  bad({ bySub: without(snap.bySub, 'sub-bia') }, 'a missing bySub entry')
  bad({ bySub: { ...snap.bySub, 'sub-outra': b } }, 'an extra bySub entry')
  bad({ bySub: { ...snap.bySub, 'sub-bia': a } }, 'a bySub entry pointing at another member')
  bad({ bySub: undefined }, 'no bySub at all')
  bad({ byUsername: { ...snap.byUsername, bia: a } }, 'a byUsername pointing at the wrong member')
  bad({ byUsername: without(snap.byUsername, 'bia') }, 'a missing byUsername entry')
  bad({ byUsername: { ...snap.byUsername, alba: a } }, 'a past name still in byUsername')
  bad({ usedNames: without(snap.usedNames, 'bia') }, 'usedNames missing a current name')
  bad({ usedNames: { ...snap.usedNames, outra: memberKey() } }, 'a used name held by a member with no link')
  bad({ usedNames: { ...snap.usedNames, outra: 7 } }, 'a used name held by a non-string')
  bad({ usedNames: [] }, 'usedNames that is not an object')

  fs.writeFileSync(file, JSON.stringify(snap))
  t.is(openAccountStore(dir, { readOnly: true }).status(a).username, 'albinha', 'the consistent snapshot with a past name opens (readOnly)')
  const rw = open()
  t.is(rw.lookup('bia').member, b, 'and opens rw')
  throwsCode(t, () => rw.start({ member: memberKey(), username: 'alba' }), 'nome-em-uso', 'the past name is still never reissued')
})

// The high-water mark: directory.hwm, outside the snapshot+journal pair.

test('hwm: a snapshot and journal restored from an older backup are refused rw and reported readOnly; removing directory.hwm acknowledges the restore', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const file = path.join(dir, FILE)
  const hwm = path.join(dir, HWM)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  await store.close()
  t.alike(readHwmFile(dir).seq, 1)
  t.is(fs.statSync(hwm).mode & 0o777, 0o600)
  // A backup taken with the service stopped: directory.json (v 1, seq 1).
  const backup = fs.readFileSync(file)
  const hwmBackup = fs.readFileSync(hwm)

  const next = open()
  const b = memberKey()
  await link(next, iss, b, 'bia')
  await next.close()
  t.is(readHwmFile(dir).seq, 2)

  // The older copy restored: the name "bia" and its Google account would be
  // free again.
  fs.writeFileSync(file, backup)
  t.exception(() => open(), /diretório de contas restaurado de uma cópia antiga; confira o backup/, 'a rw open refuses')
  try {
    open()
    t.fail('opened')
  } catch (err) {
    t.is(err.code, 'RESTAURADO', 'with its own code')
  }
  t.is(fs.readFileSync(file, 'utf8'), backup.toString(), 'the refused open wrote nothing')
  const ro = openAccountStore(dir, { readOnly: true })
  t.is(ro.restored, true, 'a readOnly open reports it')
  t.alike(ro.exportLinks().map((l) => l.member), [a], 'and still reads')
  t.is(openAccountStore(dir, { readOnly: true, maxMembers: 1 }).isFull(), true)

  // The whole pair plus the hwm from the same backup: not a restore of an
  // older copy relative to its own mark.
  fs.writeFileSync(hwm, hwmBackup)
  t.is(openAccountStore(dir, { readOnly: true }).restored, false, 'the hwm restored with its pair')
  fs.writeFileSync(hwm, JSON.stringify({ seq: 2, journal: null }))

  // The operator who means it removes the mark.
  fs.unlinkSync(hwm)
  const rw = open()
  t.is(rw.restored, false)
  await link(rw, iss, memberKey(), 'bia')
  await rw.close()
  t.is(readHwmFile(dir).seq, 2, 'a new mark from the restored pair on')

  // A damaged mark fails closed; a mark at or below the pair opens.
  fs.writeFileSync(hwm, 'lixo')
  refusedOpen(t, dir, 'an unparsable hwm')
  fs.writeFileSync(hwm, JSON.stringify({ seq: -1, journal: null }))
  refusedOpen(t, dir, 'a negative seq')
  fs.writeFileSync(hwm, JSON.stringify({ seq: 1, journal: 'xyz' }))
  refusedOpen(t, dir, 'a journal that is not an id')
  fs.writeFileSync(hwm, JSON.stringify({ seq: 1, journal: null }))
  t.is(open().restored, false, 'a mark below the pair (a crash before the last compaction wrote it) opens')
  fs.writeFileSync(hwm, JSON.stringify({ seq: 3, journal: null }))
  t.exception(() => open(), /restaurado de uma cópia antiga/)
  fs.unlinkSync(hwm)
  fs.symlinkSync(file, hwm)
  refusedOpen(t, dir, 'a symlink at directory.hwm')
})

test('hwm: a v 2 pair below the mark is refused too, and the mark follows every compaction and close', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const file = path.join(dir, FILE)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  await link(store, iss, memberKey(), 'bia')
  const journal = journalFile(dir)
  // A backup taken while the service ran (both files, consistent).
  const backup = { snapshot: fs.readFileSync(file), journal: fs.readFileSync(journal), id: readSnapshotFile(dir).journal }
  t.absent(fs.existsSync(path.join(dir, HWM)), 'no mark yet: nothing compacted or closed')
  await store.close()
  t.is(readHwmFile(dir).seq, 2)
  const rw = open()
  await link(rw, iss, memberKey(), 'cora')
  await rw.close()
  t.is(readHwmFile(dir).seq, 3)

  for (const id of journalIds(dir)) fs.unlinkSync(journalPath(dir, id))
  fs.writeFileSync(file, backup.snapshot)
  fs.writeFileSync(journalPath(dir, backup.id), backup.journal)
  t.exception(() => open(), /restaurado de uma cópia antiga/, 'seq 2 from the pair under a mark at 3')
  t.is(openAccountStore(dir, { readOnly: true }).restored, true)
  t.alike(openAccountStore(dir, { readOnly: true }).exportLinks().length, 2)
  fs.writeFileSync(path.join(dir, HWM), JSON.stringify({ seq: 2, journal: backup.id }))
  t.is(open().exportLinks().length, 2, 'a mark at the pair opens')
})

test('hwm: a snapshot without seq (an older build\'s, after a rollback) is judged by its counts: equal or higher opens and continues the numbering, fewer links or names is a restore', async (t) => {
  const { store, iss, dir, open, c } = setup(t)
  const file = path.join(dir, FILE)
  const a = memberKey()
  const b = memberKey()
  await link(store, iss, a, 'alba', 'sub-alba')
  await link(store, iss, b, 'bia', 'sub-bia')
  c.t += COOLDOWN_MS
  await store.rename(a, 'albinha', iss.kp, iss.cert)
  await store.close()
  // The mark's seq and counts (its journal id is the compacted one).
  const marks = () => {
    const { seq, links, names } = readHwmFile(dir)
    return { seq, links, names }
  }
  t.alike(marks(), { seq: 3, links: 2, names: 3 }, 'the mark records the counts')
  const snap = readSnapshotFile(dir)
  const olderBuild = (patch) => {
    const out = { ...snap, ...patch }
    delete out.seq
    return out
  }
  // A link record under `username`, as whole as a's.
  const linkFor = (username, sub) => ({ ...snap.links[a], sub, username })

  // Rolled back: the older build rewrote directory.json without `seq`,
  // with the same links. Rolled forward: opens, without deleting the mark.
  fs.writeFileSync(file, JSON.stringify(olderBuild({})))
  t.is(openAccountStore(dir, { readOnly: true }).restored, false, 'equal counts: not a restore')
  const rw = open()
  t.is(rw.restored, false, 'opens read-write with the mark in place')
  t.is(readSnapshotFile(dir).seq, 3, 'and continues the numbering from the mark')
  const d = memberKey()
  await link(rw, iss, d, 'dora', 'sub-dora')
  await rw.close()
  t.alike(marks(), { seq: 4, links: 3, names: 4 }, 'the mark keeps growing')

  // The older build linked one more member: higher counts open too.
  const after = readSnapshotFile(dir)
  const e = memberKey()
  const more = { ...after, links: { ...after.links, [e]: linkFor('eva', 'sub-eva') }, bySub: { ...after.bySub, 'sub-eva': e }, byUsername: { ...after.byUsername, eva: e }, usedNames: { ...after.usedNames, eva: e } }
  delete more.seq
  fs.writeFileSync(file, JSON.stringify(more))
  t.is(openAccountStore(dir, { readOnly: true }).restored, false, 'higher counts: not a restore')
  t.is(open().exportLinks().length, 4, 'opens')
  await link(open(), iss, memberKey(), 'fabi', 'sub-fabi')
  t.is(readHwmFile(dir).seq, 4, 'the mark is written by compaction and close only')

  // Fewer links than the mark (3): the copy forgot dora.
  const { [d]: _d, ...withoutD } = after.links
  const fewerLinks = { ...after, links: withoutD, bySub: { 'sub-alba': a, 'sub-bia': b }, byUsername: { albinha: a, bia: b }, usedNames: { alba: a, albinha: a, bia: b } }
  delete fewerLinks.seq
  for (const id of journalIds(dir)) fs.unlinkSync(journalPath(dir, id))
  fs.writeFileSync(file, JSON.stringify(fewerLinks))
  t.exception(() => open(), /restaurado de uma cópia antiga/, 'fewer links: refused')
  t.is(openAccountStore(dir, { readOnly: true }).restored, true, 'and reported')

  // The same links but a past name forgotten (names 3 below the mark's 4).
  const fewerNames = { ...after, usedNames: { albinha: a, bia: b, dora: d } }
  delete fewerNames.seq
  fs.writeFileSync(file, JSON.stringify(fewerNames))
  t.exception(() => open(), /restaurado de uma cópia antiga/, 'fewer names: refused')

  // With `seq` present the seq rule decides, as before.
  fs.writeFileSync(file, JSON.stringify({ ...fewerNames, seq: 3 }))
  t.exception(() => open(), /restaurado de uma cópia antiga/, 'a seq below the mark: refused')
  fs.writeFileSync(file, JSON.stringify({ ...after, seq: 4 }))
  t.is(open().exportLinks().length, 3, 'a seq at the mark opens')
})

test('hwm: the mark is written under the fence and never lowered; a stored mark above the store\'s makes the compaction indisponivel and leaves the file untouched', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const hwm = path.join(dir, HWM)
  await fill(store, iss, 0, COMPACT_EVERY)
  t.absent(fs.existsSync(hwm), 'no mark before the first compaction')
  const raised = JSON.stringify({ seq: 500, journal: null, links: 1, names: 1 })
  fs.writeFileSync(hwm, raised)
  const late = memberKey()
  const row = claim(store, late, 'tardia', 'sub-tardia')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the compaction due before the append refuses to lower the mark')
  t.is(fs.readFileSync(hwm, 'utf8'), raised, 'the mark is untouched')
  t.is(store.status(late).linked, false, 'nothing acknowledged')
  t.is(readSnapshotFile(dir).seq, COMPACT_EVERY, 'the compacted snapshot was published before the mark')
  const row2 = claim(store, memberKey(), 'outra', 'sub-outra')
  await rejects(t, store.finish(row2.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the store is unavailable')
  t.exception(() => open(), /restaurado de uma cópia antiga/, 'the next open judges the directory against that mark')

  // A mark whose counts are above the store's is not lowered either.
  const { store: other, iss: iss2, dir: dir2 } = setup(t)
  await link(other, iss2, memberKey(), 'alba')
  const countsUp = JSON.stringify({ seq: 0, journal: null, links: 5, names: 5 })
  fs.writeFileSync(path.join(dir2, HWM), countsUp)
  await rejects(t, other.close(), 'indisponivel', 'the close\'s mark would lower the counts')
  t.is(fs.readFileSync(path.join(dir2, HWM), 'utf8'), countsUp)
  t.is(readSnapshotFile(dir2).v, 2, 'and the v 1 snapshot was not written')
})

test('onUnavailable: called once on a writer guard trip, never for fail() or a readOnly store', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const iss = issuer()
  let calls = 0
  const store = openAccountStore(dir, { now: c.now, onUnavailable: () => { calls++ } })
  const a = memberKey()
  await link(store, iss, a, 'alba')
  t.is(calls, 0, 'not called while the store works')
  fs.truncateSync(journalFile(dir), 0)
  const row = claim(store, memberKey(), 'bia', 'sub-bia')
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'the guard trips')
  t.is(calls, 1, 'called on the guard trip')
  c.t += COOLDOWN_MS
  await rejects(t, store.rename(a, 'albinha', iss.kp, iss.cert), 'indisponivel', 'later mutations refused')
  t.is(calls, 1, 'called only once')

  const other = path.join(tmpDir(t), 'account')
  let failCalls = 0
  const failing = openAccountStore(other, { now: c.now, onUnavailable: () => { failCalls++ } })
  await link(failing, iss, memberKey(), 'cora')
  failing.fail()
  fs.truncateSync(journalFile(other), 0)
  const row2 = claim(failing, memberKey(), 'dora', 'sub-dora')
  await rejects(t, failing.finish(row2.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'refused after fail()')
  t.is(failCalls, 0, 'fail() (lock loss) does not call it, nor a later failure')

  let readOnlyCalls = 0
  const ro = openAccountStore(path.join(tmpDir(t), 'account'), { readOnly: true, onUnavailable: () => { readOnlyCalls++ } })
  const row3 = claim(ro, memberKey(), 'eva', 'sub-eva')
  await rejects(t, ro.finish(row3.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'indisponivel', 'readOnly refuses')
  t.is(readOnlyCalls, 0, 'a readOnly store never calls it')
})

// Sign-up invites: the id rides on the memory-only pending row and, once the
// link is finished, on the link record (strict single use).
const INVITE = 'c'.repeat(64)

async function inviteLink (s, iss, member, username, invite = INVITE, sub = 'sub-' + member.slice(0, 8), email = 'm@example.test') {
  const row = s.start({ member, username, invite })
  s.reserve(row.id)
  s.putGoogle(row.id, { sub, email })
  return s.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
}

function snapshotLink (dir, member) {
  return readSnapshotFile(dir).links[member]
}

test('invite: the pending row keeps a lowercase hex64 invite or null; anything else is a TypeError', (t) => {
  const { store } = setup(t)
  const member = memberKey()
  t.is(store.get(store.start({ member, username: 'ana' }).id).invite, null, 'no invite: null')
  t.is(store.get(store.start({ member, username: 'ana', invite: INVITE }).id).invite, INVITE, 'kept on the row')
  for (const bad of ['C'.repeat(64), 'c'.repeat(63), 'g'.repeat(64), 'xyz', 42, {}, ['c'.repeat(64)]]) {
    t.exception.all(() => store.start({ member, username: 'ana', invite: bad }), TypeError, JSON.stringify(bad))
  }
})

test('invite: a finished link stores it in the journal and the snapshot; inviteUsed survives close, reopen and a rename', async (t) => {
  const { store, iss, dir, open, c } = setup(t)
  const a = memberKey()
  t.is(store.inviteUsed(INVITE), false, 'unused before the link')
  await inviteLink(store, iss, a, 'alba')
  t.is(journalLines(dir)[0].link.invite, INVITE, 'the link line carries the invite')
  t.is(store.inviteUsed(INVITE), true)
  t.is(store.inviteUsed('d'.repeat(64)), false, 'another invite is unused')
  t.exception.all(() => store.inviteUsed('C'.repeat(64)), TypeError, 'a malformed id is a TypeError')
  t.exception.all(() => store.inviteUsed(null), TypeError, 'null is a TypeError')
  await store.close()
  t.is(snapshotLink(dir, a).invite, INVITE, 'the v 1 snapshot keeps it')
  const two = open()
  t.is(two.inviteUsed(INVITE), true, 'after reopen')
  c.t += COOLDOWN_MS
  await two.rename(a, 'albinha', iss.kp, iss.cert)
  t.is(two.inviteUsed(INVITE), true, 'after a rename')
  await two.close()
  const link = snapshotLink(dir, a)
  t.is(link.username, 'albinha')
  t.is(link.invite, INVITE, 'the rename kept it on the link')
  t.is(openAccountStore(dir, { readOnly: true }).inviteUsed(INVITE), true, 'a readOnly open reads it')
})

test('invite: a second member finishing with the same invite is convite-invalido and its row is dropped', async (t) => {
  const { store, iss, dir } = setup(t)
  const b = memberKey()
  const late = store.start({ member: b, username: 'bia', invite: INVITE })
  store.reserve(late.id)
  store.putGoogle(late.id, { sub: 'sub-bia', email: 'b@example.test' })
  await inviteLink(store, iss, memberKey(), 'alba')
  const before = fs.readFileSync(journalFile(dir), 'utf8')
  await rejects(t, store.finish(late.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'convite-invalido', 'the invite was used meanwhile')
  t.is(store.get(late.id), null, 'the row is dropped')
  t.is(store.status(b).linked, false, 'nothing linked')
  t.is(fs.readFileSync(journalFile(dir), 'utf8'), before, 'nothing written')
  t.ok(await inviteLink(store, iss, b, 'bia', 'd'.repeat(64), 'sub-bia'), 'another invite still links')
})

test('invite: the e-mail update of a linked member is not refused and keeps the invite', async (t) => {
  const { store, iss, dir } = setup(t)
  const member = memberKey()
  const r1 = store.start({ member, username: 'eva', invite: INVITE })
  const r2 = store.start({ member, username: 'eva', invite: INVITE })
  for (const r of [r1, r2]) store.reserve(r.id)
  store.putGoogle(r1.id, { sub: 'sub-eva', email: 'old@example.test' })
  store.putGoogle(r2.id, { sub: 'sub-eva', email: 'new@example.test' })
  await store.finish(r1.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  await store.finish(r2.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.is(store.exportLinks()[0].email, 'new@example.test')
  await store.close()
  t.is(snapshotLink(dir, member).invite, INVITE, 'kept through the e-mail line')
})

test('invite: inviteUsed survives a compaction', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  await inviteLink(store, iss, a, 'alba')
  await fill(store, iss, 0, COMPACT_EVERY + 1)
  const disk = readSnapshotFile(dir)
  t.is(disk.v, 2)
  t.ok(disk.seq >= COMPACT_EVERY, 'compacted')
  t.is(disk.links[a].invite, INVITE, 'the compacted snapshot keeps it')
  t.is(store.inviteUsed(INVITE), true, 'after the compaction')
  t.is(open().inviteUsed(INVITE), true, 'after a rw open')
})

test('invite: a link made without one has no invite key on disk, nor in exportLinks', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'alba')
  t.absent(JSON.stringify(journalLines(dir)).includes('invite'), 'no invite in the journal')
  await inviteLink(store, iss, memberKey(), 'bia')
  for (const row of store.exportLinks()) {
    t.alike(Object.keys(row).sort(), ['email', 'linkedAt', 'member', 'sub', 'username'], 'no invite in the export')
  }
  await store.close()
  t.absent(Object.hasOwn(snapshotLink(dir, a), 'invite'), 'no invite key in directory.json')
})

test('invite: a directory.json whose link has an invite that is not lowercase hex64 is refused', async (t) => {
  const { store, iss, dir } = setup(t)
  const a = memberKey()
  await inviteLink(store, iss, a, 'alba')
  await store.close()
  const good = readSnapshotFile(dir)
  for (const bad of ['XYZ', 'C'.repeat(64), null, 7]) {
    const snap = JSON.parse(JSON.stringify(good))
    snap.links[a].invite = bad
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(snap))
    t.exception(() => openAccountStore(dir, { readOnly: true }), /diretório de contas inválido/, JSON.stringify(bad))
  }
})

test('invite: a journal where two links carry the same invite still opens and the invite reads as used', async (t) => {
  const { store, iss, dir, open } = setup(t)
  await inviteLink(store, iss, memberKey(), 'alba')
  await link(store, iss, memberKey(), 'bia')
  const log = journalFile(dir)
  const [header, first, second] = fs.readFileSync(log, 'utf8').trim().split('\n')
  const planted = JSON.parse(second)
  planted.link.invite = INVITE
  fs.writeFileSync(log, [header, first, JSON.stringify(planted)].join('\n') + '\n')
  const ro = openAccountStore(dir, { readOnly: true })
  t.is(ro.exportLinks().length, 2, 'both links replayed')
  t.is(ro.inviteUsed(INVITE), true)
  const rw = open()
  t.is(rw.inviteUsed(INVITE), true, 'a rw open compacts them too')
  await rw.close()
  t.is(Object.values(readSnapshotFile(dir).links).filter((l) => l.invite === INVITE).length, 2)
})
