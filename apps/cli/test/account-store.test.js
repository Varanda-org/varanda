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
const { openAccountStore, COOLDOWN_MS, PENDING_TTL_MS, MAX_PENDING, MAX_UNPROVEN_PER_MEMBER, MAX_PER_SUB, FILE } = require('../lib/account/store')
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

test('a killed write leaves the previous directory.json and no link', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const a = memberKey()
  await link(store, iss, a, 'joao', 'sub-joao')
  const file = path.join(dir, FILE)
  const before = fs.readFileSync(file, 'utf8')

  const b = memberKey()
  const row = store.start({ member: b, username: 'kira' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: 'sub-kira', email: 'k@example.test' })
  const rename = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error('killed'), { code: 'EIO' }) }
  try {
    await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'write fails')
  } finally {
    fs.renameSync = rename
  }
  t.is(fs.readFileSync(file, 'utf8'), before, 'previous file intact')
  t.ok(JSON.parse(before).links[a], 'previous file readable')
  t.alike(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left')
  t.is(store.status(b).linked, false, 'memory unchanged')
  t.is(open().status(b).linked, false, 'disk unchanged')
  t.is(store.lookup('kira'), null)

  const res = await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.ok(res.cert, 'the row survives the failure, so a retry succeeds')
  t.is(open().status(b).username, 'kira')
})

// Makes the fsync of `dir` itself (the one writeJsonAtomic does AFTER the
// rename) throw `fault.code` while it is set; file fsyncs are untouched, so
// the new directory.json is already installed when the error is raised.
function dirFsyncFault (t, dir) {
  const { openSync, fsyncSync } = fs
  t.teardown(() => { fs.openSync = openSync; fs.fsyncSync = fsyncSync }, { force: true })
  const dirFds = new Set()
  const fault = { code: null }
  fs.openSync = function (p, ...rest) {
    const fd = openSync.call(fs, p, ...rest)
    if (p === dir) dirFds.add(fd)
    else dirFds.delete(fd)
    return fd
  }
  fs.fsyncSync = function (fd) {
    if (dirFds.has(fd) && fault.code !== null) {
      throw Object.assign(new Error('simulado'), { code: fault.code })
    }
    return fsyncSync.call(fs, fd)
  }
  return fault
}

test('a write that fails after the rename: memory reloads the published link', async (t) => {
  const { store, iss, dir, open } = setup(t)
  const fault = dirFsyncFault(t, dir)
  const b = memberKey()
  const row = store.start({ member: b, username: 'kira' })
  const again = store.start({ member: b, username: 'kira' })
  for (const r of [row, again]) {
    store.reserve(r.id)
    store.putGoogle(r.id, { sub: 'sub-kira', email: 'k@example.test' })
  }

  fault.code = 'EIO'
  await rejects(t, store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'EIO', 'the call fails')
  fault.code = null

  const disk = open().status(b)
  t.is(disk.linked, true, 'the link is on disk')
  const st = store.status(b)
  t.is(st.linked, true, 'memory reports the link')
  t.alike(st.cert, disk.cert, 'with the cert from disk')
  t.alike(st.usernameRecord, disk.usernameRecord)
  t.alike(store.lookup('kira'), { member: b, usernameRecord: disk.usernameRecord })

  const retry = await store.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.alike(retry.cert, disk.cert, 'the surviving row is answered with the stored cert')
  const second = await store.finish(again.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
  t.alike(second.cert, disk.cert, 'a second row for the same sub+member too')
  t.alike(second.usernameRecord, disk.usernameRecord)
  t.is(open().exportLinks().length, 1, 'still one link on disk')
})

test('a rename that fails after the rename of the file: memory reloads the new name', async (t) => {
  const { store, iss, dir, open, c } = setup(t)
  const fault = dirFsyncFault(t, dir)
  const member = memberKey()
  const first = await link(store, iss, member, 'lara')
  c.t = T0 + COOLDOWN_MS

  fault.code = 'EIO'
  await rejects(t, store.rename(member, 'luna', iss.kp, iss.cert), 'EIO', 'the call fails')
  fault.code = null

  const disk = open().status(member)
  t.is(disk.username, 'luna', 'the new name is on disk')
  const st = store.status(member)
  t.is(st.username, 'luna', 'memory shows the new name')
  t.alike(st.usernameRecord, disk.usernameRecord)
  t.is(st.nextChangeAt, disk.nextChangeAt, 'and the nextChangeAt from disk')
  t.is(st.nextChangeAt, new Date(c.t + COOLDOWN_MS).toISOString())
  t.alike(st.cert, first.cert)
  t.is(store.lookup('lara'), null, 'the old name is released')
  t.is(store.lookup('luna').member, member)

  const retry = await store.rename(member, 'luna', iss.kp, iss.cert)
  t.alike(retry, { record: disk.usernameRecord, nextChangeAt: disk.nextChangeAt }, 'a retry answers the unchanged record')
})

test('a failed write whose file cannot be reloaded marks the store unavailable', async (t) => {
  const { store, iss, dir, c } = setup(t)
  const fault = dirFsyncFault(t, dir)
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
  t.is(JSON.parse(readFileSync(path.join(dir, FILE), 'utf8')).links[member].username, 'mona', 'the published file is untouched')
})

test('rename: 7-day cooldown with an injected clock', async (t) => {
  const { store, iss, c, open } = setup(t)
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

  const st = open().status(member)
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
