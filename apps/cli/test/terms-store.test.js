'use strict'

// apps/cli/lib/account/terms-store.js: the terms.json sidecar where the
// account service records which Termos/Política versions each member key
// accepted. No network; the clock is injected and disk failures are
// simulated by wrapping fs functions.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openTermsStore, FILE, MAX_PER_MEMBER, MAX_MEMBERS } = require('../lib/account/terms-store')
const { openAccountStore } = require('../lib/account/store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-24T12:00:00.000Z')
const HOUR = 3600 * 1000
const SIG = 'ab'.repeat(64)
const NONCE = 'n'.repeat(43)

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = clock()
  const open = (more = {}) => openTermsStore(dir, { now: c.now, ...opts, ...more })
  return { dir, file: path.join(dir, FILE), c, open, store: open() }
}

function req (member, version, extra = {}) {
  return { member, version, nonce: NONCE, signature: SIG, ...extra }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Counts the renames onto `file` (writeJsonAtomic publishes with one).
function countRenames (t, file) {
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  const counter = { n: 0 }
  fs.renameSync = function (from, to) {
    if (to === file) counter.n++
    return renameSync.call(fs, from, to)
  }
  return counter
}

test('an empty data dir writes nothing until the first accept', async (t) => {
  const { store, file, dir } = setup(t)
  t.ok(store.available())
  t.is(store.count(), 0)
  t.alike(store.list(memberKey()), [])
  t.alike(fs.readdirSync(dir), [])
  const m = memberKey()
  const out = await store.accept(req(m, 1))
  t.alike(out, { version: 1, acceptedAt: new Date(T0).toISOString(), changed: true })
  t.ok(fs.existsSync(file))
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  t.alike(readFile(file), { v: 1, members: { [m]: [{ version: 1, acceptedAt: new Date(T0).toISOString(), nonce: NONCE, signature: SIG }] } })
})

test('a repeat keeps the first date and does not write', async (t) => {
  const { store, c, file } = setup(t)
  const m = memberKey()
  const first = await store.accept(req(m, 1))
  const renames = countRenames(t, file)
  c.t += HOUR
  const again = await store.accept(req(m, 1, { nonce: 'x'.repeat(43) }))
  t.alike(again, { version: 1, acceptedAt: first.acceptedAt, changed: false })
  t.is(renames.n, 0, 'idempotent repeat already on disk is not rewritten')
  t.is(readFile(file).members[m][0].nonce, NONCE)
})

test('the per-member cap drops the lowest version', async (t) => {
  const { store, c, file } = setup(t)
  const m = memberKey()
  for (let v = 1; v <= MAX_PER_MEMBER + 2; v++) {
    await store.accept(req(m, v))
    c.t += 1000
  }
  const list = store.list(m)
  t.is(list.length, MAX_PER_MEMBER)
  t.is(list[0].version, 3, 'oldest dropped')
  t.is(list[list.length - 1].version, MAX_PER_MEMBER + 2)
  t.is(readFile(file).members[m].length, MAX_PER_MEMBER)
})

test('list hides nonce and signature, oldest first; count counts members', async (t) => {
  const { store, c } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.accept(req(a, 2))
  c.t += 1000
  await store.accept(req(a, 3))
  await store.accept(req(b, 2))
  t.alike(store.list(a), [
    { version: 2, acceptedAt: new Date(T0).toISOString() },
    { version: 3, acceptedAt: new Date(T0 + 1000).toISOString() }
  ])
  t.is(store.count(), 2)
})

test('bad argument shapes throw TypeError', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const bad = [
    req(m.toUpperCase(), 1),
    req('ab', 1),
    req(m, 0),
    req(m, 10000),
    req(m, 1.5),
    req(m, '1'),
    req(m, 1, { nonce: 'short' }),
    req(m, 1, { nonce: 'n'.repeat(43) + '=' }),
    req(m, 1, { signature: 'AB'.repeat(64) }),
    req(m, 1, { signature: 'ab'.repeat(32) })
  ]
  for (const r of bad) {
    try {
      await store.accept(r)
      t.fail('accepted ' + JSON.stringify(r))
    } catch (err) {
      t.ok(err instanceof TypeError)
    }
  }
  t.exception.all(() => store.list('nope'), TypeError)
  t.absent(fs.existsSync(file))
})

test('a malformed file stays byte-identical and answers indisponivel', async (t) => {
  const m = memberKey()
  const good = { version: 1, acceptedAt: new Date(T0).toISOString(), nonce: NONCE, signature: SIG }
  const cases = [
    'not json',
    JSON.stringify({ v: 2, members: {} }),
    JSON.stringify({ v: 1, members: {}, extra: 1 }),
    JSON.stringify({ v: 1, members: { [m.toUpperCase()]: [good] } }),
    JSON.stringify({ v: 1, members: { [m]: [{ ...good, version: 0 }] } }),
    JSON.stringify({ v: 1, members: { [m]: [{ ...good, acceptedAt: '2026-10-24' }] } }),
    JSON.stringify({ v: 1, members: { [m]: [{ ...good, nonce: 'x' }] } }),
    JSON.stringify({ v: 1, members: { [m]: [{ ...good, signature: 'ab' }] } }),
    JSON.stringify({ v: 1, members: { [m]: [{ ...good, email: 'a@b.c' }] } }),
    JSON.stringify({ v: 1, members: { [m]: [good, { ...good, acceptedAt: new Date(T0 + 1).toISOString() }] } }),
    JSON.stringify({ v: 1, members: { [m]: Array.from({ length: MAX_PER_MEMBER + 1 }, (_, i) => ({ ...good, version: i + 1 })) } })
  ]
  for (const bytes of cases) {
    const { dir, file, open } = setup(t)
    fs.writeFileSync(file, bytes)
    const store = open()
    t.absent(store.available(), 'unavailable: ' + bytes.slice(0, 40))
    t.exception(() => store.list(m))
    t.exception(() => store.count())
    await rejects(t, store.accept(req(m, 1)), 'indisponivel', 'accept refused')
    t.is(fs.readFileSync(file, 'utf8'), bytes, 'bytes untouched')
    t.alike(fs.readdirSync(dir), [FILE])
  }
})

test('a member with no acceptance is refused whole and never rewritten', async (t) => {
  const { file, open } = setup(t)
  const bytes = JSON.stringify({ v: 1, members: { [memberKey()]: [] } })
  fs.writeFileSync(file, bytes)
  const store = open()
  t.absent(store.available(), 'an empty list is never written by this store')
  await rejects(t, store.accept(req(memberKey(), 1)), 'indisponivel', 'accept refused')
  t.is(fs.readFileSync(file, 'utf8'), bytes, 'bytes untouched')
})

test('a file past the member cap still opens; only new admissions are refused', async (t) => {
  const { file, open } = setup(t)
  const entry = [{ version: 1, acceptedAt: new Date(T0).toISOString(), nonce: NONCE, signature: SIG }]
  const members = {}
  for (let i = 0; i <= MAX_MEMBERS; i++) members[i.toString(16).padStart(64, '0')] = entry
  fs.writeFileSync(file, JSON.stringify({ v: 1, members }))
  const store = open()
  t.ok(store.available(), 'a union a heal may write is still readable')
  const known = (0).toString(16).padStart(64, '0')
  t.is((await store.accept(req(known, 2))).changed, true, 'an existing member can accept')
  await rejects(t, store.accept(req(memberKey(), 1)), 'limite', 'a new member is refused')
})

test('a non-regular terms.json is refused', async (t) => {
  const { file, open } = setup(t)
  fs.mkdirSync(file)
  const store = open()
  t.absent(store.available())
  await rejects(t, store.accept(req(memberKey(), 1)), 'indisponivel', 'directory in place of the file')
})

test('readOnly never creates the file', async (t) => {
  const { dir, file, open } = setup(t)
  const store = open({ readOnly: true })
  t.ok(store.available())
  t.is(store.count(), 0)
  await rejects(t, store.accept(req(memberKey(), 1)), 'indisponivel', 'readOnly refuses accept')
  t.absent(fs.existsSync(file))
  t.alike(fs.readdirSync(dir), [])
})

test('open never creates a missing data dir', (t) => {
  const dir = path.join(tmpDir(t), 'missing')
  const store = openTermsStore(dir)
  t.ok(store.available())
  t.absent(fs.existsSync(dir))
})

test('a symlinked data dir is refused', (t) => {
  const root = tmpDir(t)
  const real = path.join(root, 'real')
  fs.mkdirSync(real)
  const link = path.join(root, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openTermsStore(link))
})

test('guard() false refuses that request only and leaves the file unchanged', async (t) => {
  let ok = true
  const { store, file } = setup(t, { guard: () => ok })
  const m = memberKey()
  await store.accept(req(m, 1))
  const before = fs.readFileSync(file, 'utf8')
  ok = false
  await rejects(t, store.accept(req(m, 2)), 'indisponivel', 'guard refused')
  t.is(fs.readFileSync(file, 'utf8'), before)
  t.ok(store.available(), 'a transient refusal does not wedge the store')
  ok = true
  const out = await store.accept(req(m, 3))
  t.is(out.changed, true, 'the next accept with the guard back succeeds')
  t.alike(readFile(file).members[m].map((e) => e.version), [1, 3])
})

test('fail() refuses later accepts', async (t) => {
  const { store } = setup(t)
  store.fail()
  t.absent(store.available())
  await rejects(t, store.accept(req(memberKey(), 1)), 'indisponivel', 'after fail()')
})

test('concurrent accepts serialize', async (t) => {
  const { store, file, open } = setup(t)
  const members = Array.from({ length: 10 }, memberKey)
  const outs = await Promise.all(members.flatMap((m) => [store.accept(req(m, 1)), store.accept(req(m, 1)), store.accept(req(m, 2))]))
  t.is(outs.filter((o) => o.changed).length, 20)
  t.is(store.count(), 10)
  const disk = readFile(file)
  t.is(Object.keys(disk.members).length, 10)
  for (const m of members) t.is(disk.members[m].length, 2)
  t.is(open().count(), 10)
})

test('reopen reads back', async (t) => {
  const { store, c, open } = setup(t)
  const m = memberKey()
  await store.accept(req(m, 1))
  c.t += HOUR
  await store.accept(req(m, 2))
  const again = open()
  t.alike(again.list(m), store.list(m))
  const repeat = await again.accept(req(m, 1))
  t.is(repeat.acceptedAt, new Date(T0).toISOString())
  t.is(repeat.changed, false)
})

test('a failed write followed by a repeat rewrites before answering', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.accept(req(m, 1))
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  // The rename lands, then the call throws, as a failing dir fsync would.
  let renames = 0
  let failNext = true
  fs.renameSync = function (from, to) {
    const out = renameSync.call(fs, from, to)
    if (to === file) {
      renames++
      if (failNext) {
        failNext = false
        throw Object.assign(new Error('simulado'), { code: 'EIO' })
      }
    }
    return out
  }
  try {
    await store.accept(req(m, 2))
    t.fail('write failure not reported')
  } catch (err) {
    t.is(err.code, 'EIO')
  }
  t.ok(store.available())
  t.is(renames, 1)
  const repeat = await store.accept(req(m, 2))
  t.is(repeat.changed, false, 'the reload kept the landed entry')
  t.is(renames, 2, 'the dirty store rewrote before answering')
  const third = await store.accept(req(m, 2))
  t.is(third.changed, false)
  t.is(renames, 2, 'clean again: no further rewrite')
})

test('a failed write whose file cannot be reloaded marks the store unavailable', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.accept(req(m, 1))
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = function (from, to) {
    if (to === file) {
      fs.unlinkSync(from)
      fs.writeFileSync(file, 'garbage')
      throw Object.assign(new Error('simulado'), { code: 'EIO' })
    }
    return renameSync.call(fs, from, to)
  }
  await rejects(t, store.accept(req(m, 2)), 'EIO', 'write failed')
  t.absent(store.available())
})

test('an external replacement missing an acknowledged entry is healed by the next accept', async (t) => {
  const { store, file, c } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.accept(req(a, 1))
  c.t += HOUR
  await store.accept(req(b, 1))
  // Another holder writes a file that lacks a's acceptance but has its own.
  const other = memberKey()
  const otherEntry = { version: 1, acceptedAt: new Date(T0 + 2 * HOUR).toISOString(), nonce: NONCE, signature: SIG }
  const disk = readFile(file)
  delete disk.members[a]
  disk.members[other] = [otherEntry]
  fs.writeFileSync(file, JSON.stringify(disk))
  const renames = countRenames(t, file)
  // An idempotent repeat for another member still rewrites the union.
  const out = await store.accept(req(b, 1))
  t.is(out.changed, false)
  t.is(renames.n, 1)
  const healed = readFile(file)
  t.alike(healed.members[a], [{ version: 1, acceptedAt: new Date(T0).toISOString(), nonce: NONCE, signature: SIG }], 'original date back on disk')
  t.alike(healed.members[other], [otherEntry], 'the other holder\'s entry kept')
  t.is(store.count(), 3)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
})

test('merge keeps the earliest acceptedAt for one version', async (t) => {
  const { store, file, c } = setup(t)
  const a = memberKey()
  c.t += HOUR
  await store.accept(req(a, 1))
  const disk = readFile(file)
  disk.members[a][0].acceptedAt = new Date(T0).toISOString()
  fs.writeFileSync(file, JSON.stringify(disk))
  const out = await store.accept(req(a, 1))
  t.is(out.acceptedAt, new Date(T0).toISOString())
  t.is(out.changed, false)
})

test('guard() true before and false after the write refuses to acknowledge', async (t) => {
  let calls = 0
  let failAt = 0
  const guard = () => ++calls !== failAt
  const { store, file } = setup(t, { guard })
  const m = memberKey()
  await store.accept(req(m, 1))
  // The next accept asks guard() before (call n+1) and after (n+2) the write.
  failAt = calls + 2
  await rejects(t, store.accept(req(m, 2)), 'indisponivel', 'not acknowledged after the guard failed')
  t.ok(store.available(), 'only that request was refused')
  t.is(readFile(file).members[m].length, 2, 'the write itself landed')
  const out = await store.accept(req(m, 3))
  t.is(out.changed, true, 'a later accept succeeds')
  t.alike(readFile(file).members[m].map((e) => e.version), [1, 2, 3], 'the file holds both entries')
})

test('a refusal after the write leaves the store dirty: the repeat rewrites before answering', async (t) => {
  let calls = 0
  let failAt = 0
  const guard = () => ++calls !== failAt
  const { store, file } = setup(t, { guard })
  const m = memberKey()
  await store.accept(req(m, 1))
  failAt = calls + 2
  await rejects(t, store.accept(req(m, 2)), 'indisponivel', 'not acknowledged')
  const renames = countRenames(t, file)
  const out = await store.accept(req(m, 2))
  t.is(out.changed, false)
  t.is(renames.n, 1, 'dirty: merge-written although the file already matches')
})

test('a malformed file appearing between accepts answers indisponivel and is untouched', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.accept(req(m, 1))
  const bytes = '{"v":1,"members":{"oops":[]}}'
  fs.writeFileSync(file, bytes)
  await rejects(t, store.accept(req(m, 1)), 'indisponivel', 'malformed on disk')
  t.is(fs.readFileSync(file, 'utf8'), bytes)
  t.absent(store.available())
  t.exception(() => store.list(m))
})

test('openAccountStore opens a data dir that contains terms.json', async (t) => {
  const { store, dir, file } = setup(t)
  const m = memberKey()
  await store.accept(req(m, 1))
  const before = fs.readFileSync(file, 'utf8')
  const accounts = openAccountStore(dir, { now: () => T0 })
  const row = accounts.start({ member: memberKey(), username: 'joao' })
  t.ok(row && row.id)
  await accounts.close()
  const again = openAccountStore(dir, { now: () => T0 })
  await again.close()
  t.is(fs.readFileSync(file, 'utf8'), before, 'terms.json untouched')
  t.alike(openTermsStore(dir).list(m).map((e) => e.version), [1])
})

test('an acceptance only the disk had is adopted and healed after an external replacement', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  const other = memberKey()
  await store.accept(req(other, 1))
  const withoutM = fs.readFileSync(file, 'utf8')
  const diskAt = '2026-10-01T00:00:00.000Z'
  const doc = readFile(file)
  doc.members[m] = [{ version: 1, acceptedAt: diskAt, nonce: NONCE, signature: SIG }]
  fs.writeFileSync(file, JSON.stringify(doc))
  const res = await store.accept(req(m, 1))
  t.is(res.changed, false)
  t.is(res.acceptedAt, diskAt)
  t.alike(store.list(m), [{ version: 1, acceptedAt: diskAt }])
  t.is(store.count(), 2)
  fs.writeFileSync(file, withoutM)
  c.t += HOUR
  await store.accept(req(memberKey(), 1))
  const healed = readFile(file).members[m]
  t.is(healed.length, 1)
  t.is(healed[0].acceptedAt, diskAt, 'original acceptedAt back on disk')
})

test('the per-member cap never drops the entry being added, even with the clock behind', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  for (let v = 1; v <= MAX_PER_MEMBER; v++) {
    await store.accept(req(m, v))
    c.t += HOUR
  }
  const before = fs.readFileSync(file, 'utf8')
  c.t = T0 - 10 * HOUR
  const res = await store.accept(req(m, MAX_PER_MEMBER + 1))
  t.is(res.changed, true)
  const versions = store.list(m).map((e) => e.version)
  t.is(versions.length, MAX_PER_MEMBER)
  t.ok(versions.includes(MAX_PER_MEMBER + 1))
  t.absent(versions.includes(1), 'the lowest version was dropped')
  t.is(versions[0], MAX_PER_MEMBER + 1, 'sorted oldest first')
  t.alike(readFile(file).members[m].map((e) => e.version), versions)

  // A stale writer puts the pre-accept file back: the merge keeps the
  // backdated acceptance (the cap goes by version, not by date).
  fs.writeFileSync(file, before)
  t.is(await store.heal(), true)
  t.ok(store.list(m).some((e) => e.version === MAX_PER_MEMBER + 1), 'still in memory')
  t.ok(readFile(file).members[m].some((e) => e.version === MAX_PER_MEMBER + 1), 'back on disk')

  // Below every kept version: refused, never acknowledged.
  const low = memberKey()
  for (let v = 2; v <= MAX_PER_MEMBER + 1; v++) await store.accept(req(low, v))
  await rejects(t, store.accept(req(low, 1)), 'limite', 'a version the cap would drop')
  t.absent(store.list(low).some((e) => e.version === 1))
})

test('heal() writes back an acknowledged entry an external replacement dropped', async (t) => {
  const { store, file, c } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.accept(req(a, 1))
  c.t += HOUR
  await store.accept(req(b, 1))
  const disk = readFile(file)
  delete disk.members[a]
  fs.writeFileSync(file, JSON.stringify(disk))
  t.is(await store.heal(), true)
  t.alike(readFile(file).members[a], [{ version: 1, acceptedAt: new Date(T0).toISOString(), nonce: NONCE, signature: SIG }], 'original date back on disk')
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.is(await store.heal(), false, 'nothing left to heal')
})

test('heal() with nothing to do does not write', async (t) => {
  const { store, file } = setup(t)
  t.is(await store.heal(), false, 'no file, nothing known')
  t.absent(fs.existsSync(file), 'never creates the file')
  await store.accept(req(memberKey(), 1))
  const bytes = fs.readFileSync(file, 'utf8')
  const mtime = fs.statSync(file).mtimeMs
  const renames = countRenames(t, file)
  t.is(await store.heal(), false)
  t.is(renames.n, 0)
  t.is(fs.readFileSync(file, 'utf8'), bytes)
  t.is(fs.statSync(file).mtimeMs, mtime)
})

test('heal() adopts an entry only the disk had without writing', async (t) => {
  const { store, file } = setup(t)
  await store.accept(req(memberKey(), 1))
  const disk = readFile(file)
  disk.members[memberKey()] = [{ version: 1, acceptedAt: new Date(T0).toISOString(), nonce: NONCE, signature: SIG }]
  fs.writeFileSync(file, JSON.stringify(disk))
  const renames = countRenames(t, file)
  t.is(await store.heal(), false)
  t.is(renames.n, 0)
  t.is(store.count(), 2, 'adopted')
})

test('heal() writes nothing when the guard refuses or after fail()', async (t) => {
  let ok = true
  const { store, file } = setup(t, { guard: () => ok })
  const a = memberKey()
  await store.accept(req(a, 1))
  const disk = readFile(file)
  delete disk.members[a]
  fs.writeFileSync(file, JSON.stringify(disk))
  const bytes = fs.readFileSync(file, 'utf8')
  ok = false
  t.is(await store.heal(), false, 'guard refused')
  t.is(fs.readFileSync(file, 'utf8'), bytes)
  t.ok(store.available())
  ok = true
  store.fail()
  t.is(await store.heal(), false, 'after fail()')
  t.is(fs.readFileSync(file, 'utf8'), bytes)
})

test('heal() on a readOnly store never writes', async (t) => {
  const { store, file, open } = setup(t)
  const a = memberKey()
  await store.accept(req(a, 1))
  const ro = open({ readOnly: true })
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: {} }))
  t.is(await ro.heal(), false)
  t.alike(readFile(file), { v: 1, members: {} })
})

test('heal() on a malformed file marks the store unavailable and leaves the bytes', async (t) => {
  const { store, file } = setup(t)
  await store.accept(req(memberKey(), 1))
  fs.writeFileSync(file, '{"v":1,')
  t.is(await store.heal(), false)
  t.absent(store.available())
  t.is(fs.readFileSync(file, 'utf8'), '{"v":1,')
})

test('heal() never throws when the write fails', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  await store.accept(req(a, 1))
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: {} }))
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = function () {
    const err = new Error('EIO')
    err.code = 'EIO'
    throw err
  }
  t.is(await store.heal(), false)
  fs.renameSync = renameSync
  t.is(await store.heal(), true, 'dirty: healed on the next call')
  t.is(readFile(file).members[a].length, 1)
})

// Counts the reads of `file`; `fail` makes the next ones throw its error.
function watchReads (t, file) {
  const { readFileSync } = fs
  t.teardown(() => { fs.readFileSync = readFileSync }, { force: true })
  const watch = { n: 0, fail: null, read: () => JSON.parse(readFileSync(file, 'utf8')) }
  fs.readFileSync = function (p, ...rest) {
    if (p === file) {
      watch.n++
      if (watch.fail !== null) throw watch.fail
    }
    return readFileSync.call(this, p, ...rest)
  }
  return watch
}

test('heal() keeps the store after a transient read error, logs its code and tries again', async (t) => {
  const events = []
  const { store, file } = setup(t, { log: (e) => events.push(e) })
  const a = memberKey()
  await store.accept(req(a, 1))
  const disk = readFile(file)
  delete disk.members[a]
  fs.writeFileSync(file, JSON.stringify(disk))
  const watch = watchReads(t, file)
  watch.fail = Object.assign(new Error('EIO: i/o error, read ' + file), { code: 'EIO' })
  t.is(await store.heal(), false)
  t.ok(store.available(), 'a read that failed is not a verdict on the file')
  t.alike(events, [{ event: 'terms', reason: 'leitura-falhou', code: 'EIO' }], 'the code only, no path')
  watch.fail = null
  t.is(await store.heal(), true, 'the next interval heals')
  t.ok(readFile(file).members[a], 'the dropped entry is back')
  t.is(events.length, 1)
})

test('heal() makes the store unavailable for a malformed file', async (t) => {
  const events = []
  const { store, file } = setup(t, { log: (e) => events.push(e) })
  await store.accept(req(memberKey(), 1))
  fs.writeFileSync(file, '{not json')
  t.is(await store.heal(), false)
  t.absent(store.available())
  t.alike(events, [], 'a malformed file is not a transient error')

  const { store: other, file: otherFile } = setup(t)
  await other.accept(req(memberKey(), 1))
  fs.writeFileSync(otherFile, JSON.stringify({ v: 2, members: {} }))
  t.is(await other.heal(), false)
  t.absent(other.available(), 'a valid JSON of another shape too')
})

test('heal() reads the file only when it changed or the store is dirty', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  await store.accept(req(a, 1))
  const watch = watchReads(t, file)
  t.is(await store.heal(), false)
  t.is(watch.n, 1, 'the first heal after a write reads once')
  t.is(await store.heal(), false)
  t.is(await store.heal(), false)
  t.is(watch.n, 1, 'nothing changed, nothing read')

  const disk = watch.read()
  delete disk.members[a]
  fs.writeFileSync(file, JSON.stringify(disk))
  t.is(await store.heal(), true, 'a replaced file is read and healed')
  t.is(watch.n, 2)
  t.is(await store.heal(), false)
  t.is(watch.n, 2, 'its own write is not read back again')

  fs.writeFileSync(file, JSON.stringify(watch.read()) + '\n')
  await store.heal()
  t.is(watch.n, 3, 'a rewrite with the same entries is still noticed')
})
