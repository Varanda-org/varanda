'use strict'

// apps/cli/lib/account/push-store.js: the push.json sidecar where the account
// service keeps each member's Web Push subscriptions. No network; the clock
// is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openPushStore, FILE, PUSH_MAX_PER_MEMBER, MAX_MEMBERS } = require('../lib/account/push-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-29T12:00:00.000Z')
const MIN = 60 * 1000

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function b64u (buf) {
  return Buffer.from(buf).toString('base64url')
}

function p256dh (fill = 1) {
  const buf = Buffer.alloc(65, fill)
  buf[0] = 0x04
  return b64u(buf)
}

function auth (fill = 2) {
  return b64u(Buffer.alloc(16, fill))
}

function ep (n) {
  return 'https://fcm.googleapis.com/fcm/send/device-' + n
}

function sub (member, n, extra = {}) {
  return { member, endpoint: ep(n), p256dh: p256dh(), auth: auth(), ...extra }
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = clock()
  const open = (more = {}) => openPushStore(dir, { now: c.now, ...opts, ...more })
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

async function throwsType (t, p, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.ok(err instanceof TypeError, msg)
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function validFile (member, rows) {
  return {
    v: 1,
    members: {
      [member]: rows.map((n, i) => ({ endpoint: ep(n), p256dh: p256dh(), auth: auth(), createdAt: new Date(T0 + i * MIN).toISOString() }))
    }
  }
}

// Replaces push.json the way a stalled writer's late rename would.
function replaceUnder (file, obj) {
  const tmp = file + '.stale'
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

test('put, list and remove round trip; file mode 0600', async (t) => {
  const { store, file, open } = setup(t)
  const m = memberKey()
  t.absent(fs.existsSync(file), 'opening writes nothing')
  t.alike(store.list(m), [], 'empty list')
  t.alike(await store.put(sub(m, 1)), { changed: true })
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  t.alike(store.list(m), [{ endpoint: ep(1), p256dh: p256dh(), auth: auth() }], 'list returns only the three fields')
  t.is(store.devices(m), 1)
  t.is(store.count(), 1)
  const disk = readFile(file)
  t.alike(Object.keys(disk), ['v', 'members'])
  t.alike(Object.keys(disk.members[m][0]), ['endpoint', 'p256dh', 'auth', 'createdAt'])
  t.is(disk.members[m][0].createdAt, new Date(T0).toISOString())
  t.alike(open().list(m), store.list(m), 'reopen reads back')
  t.alike(await store.remove({ member: m, endpoint: ep(1) }), { changed: true })
  t.alike(store.list(m), [])
  t.alike(readFile(file).members, {}, 'the last row deletes the member key')
  t.alike(await store.remove({ member: m, endpoint: ep(1) }), { changed: false }, 'a second remove changes nothing')
})

test('list returns fresh copies; devices and count are numbers', async (t) => {
  const { store } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.put(sub(a, 1))
  await store.put(sub(a, 2))
  await store.put(sub(b, 3))
  const got = store.list(a)
  got[0].endpoint = 'x'
  got.push({})
  t.is(store.list(a).length, 2, 'mutating the copy changes nothing')
  t.is(store.list(a)[0].endpoint, ep(1))
  t.is(typeof store.devices(a), 'number')
  t.is(store.devices(a), 2)
  t.is(store.devices(memberKey()), 0)
  t.is(store.count(), 3)
})

test('a fifth endpoint evicts the oldest', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  for (let n = 1; n <= PUSH_MAX_PER_MEMBER; n++) {
    await store.put(sub(m, n))
    c.t += MIN
  }
  t.is(store.devices(m), PUSH_MAX_PER_MEMBER)
  t.alike(await store.put(sub(m, 5)), { changed: true })
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2), ep(3), ep(4), ep(5)], 'device-1 evicted')
  t.is(await store.heal(), false, 'the evicted row does not come back')
  t.is(store.devices(m), PUSH_MAX_PER_MEMBER)
})

test('a duplicate endpoint replaces its keys in place', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  c.t += MIN
  await store.put(sub(m, 2))
  t.alike(await store.put(sub(m, 1)), { changed: false }, 'same keys: nothing changes')
  c.t += MIN
  t.alike(await store.put(sub(m, 1, { p256dh: p256dh(7), auth: auth(8) })), { changed: true })
  t.is(store.devices(m), 2, 'no second row')
  const row = readFile(file).members[m].find((r) => r.endpoint === ep(1))
  t.is(row.p256dh, p256dh(7))
  t.is(row.auth, auth(8))
  t.is(row.createdAt, new Date(T0 + 2 * MIN).toISOString(), 'createdAt replaced')
})

test('an endpoint stored under another member moves to the proving member', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.put(sub(a, 1))
  t.alike(await store.put(sub(b, 1)), { changed: true })
  t.alike(store.list(a), [])
  t.is(store.list(b)[0].endpoint, ep(1))
  t.alike(Object.keys(readFile(file).members), [b])
  t.is(store.count(), 1)
})

test('removeAll clears the member', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.put(sub(a, 1))
  await store.put(sub(a, 2))
  await store.put(sub(b, 3))
  t.alike(await store.removeAll(a), { changed: true })
  t.is(store.devices(a), 0)
  t.is(store.devices(b), 1)
  t.alike(Object.keys(readFile(file).members), [b])
  t.alike(await store.removeAll(a), { changed: false })
})

test('bad argument shapes throw TypeError', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  await throwsType(t, store.put(sub('AB'.repeat(32), 1)), 'uppercase member')
  await throwsType(t, store.put(sub(m, 1, { endpoint: 'http://example.com/x' })), 'http endpoint')
  await throwsType(t, store.put(sub(m, 1, { endpoint: 'https://u:p@example.com/x' })), 'userinfo')
  await throwsType(t, store.put(sub(m, 1, { endpoint: 'https://@example.com/x' })), 'empty userinfo')
  await throwsType(t, store.put(sub(m, 1, { endpoint: 'https://example.com/x#h' })), 'hash')
  await throwsType(t, store.put(sub(m, 1, { endpoint: 'https://example.com/\tx' })), 'tab')
  await throwsType(t, store.put(sub(m, 1, { endpoint: 'https://example.com/' + 'a'.repeat(2048) })), 'too long')
  const bad04 = Buffer.alloc(65, 1)
  bad04[0] = 0x05
  await throwsType(t, store.put(sub(m, 1, { p256dh: b64u(bad04) })), 'p256dh not starting 0x04')
  await throwsType(t, store.put(sub(m, 1, { p256dh: b64u(Buffer.alloc(64, 4)) })), 'p256dh of 64 bytes')
  await throwsType(t, store.put(sub(m, 1, { auth: auth() + '==' })), 'padded auth')
  await throwsType(t, store.put(sub(m, 1, { auth: b64u(Buffer.alloc(17, 2)) })), '17-byte auth')
  await throwsType(t, store.put(sub(m, 1, { auth: Buffer.alloc(16, 2).toString('base64') })), 'standard base64 auth')
  await throwsType(t, store.remove({ member: m, endpoint: 'nope' }), 'remove with a bad endpoint')
  await throwsType(t, store.removeAll('x'), 'removeAll with a bad member')
  t.exception.all(() => store.list('x'), /member/)
  t.exception.all(() => store.devices('x'), /member/)
  t.is(store.count(), 0)
})

test('a tampered file stays byte-identical and answers indisponivel', async (t) => {
  const m = memberKey()
  const extraKey = validFile(m, [1])
  extraKey.members[m][0].extra = 1
  const httpEndpoint = validFile(m, [1])
  httpEndpoint.members[m][0].endpoint = 'http://fcm.googleapis.com/fcm/send/x'
  const longAuth = validFile(m, [1])
  longAuth.members[m][0].auth = b64u(Buffer.alloc(17, 2))
  const topKey = validFile(m, [1])
  topKey.extra = true
  const twice = validFile(m, [1, 2])
  twice.members[memberKey()] = [{ ...twice.members[m][0] }]
  const cases = { extraKey, httpEndpoint, longAuth, topKey, twice, empty: { v: 1, members: { [m]: [] } } }
  for (const [name, obj] of Object.entries(cases)) {
    const { dir, file } = setup(t)
    const bytes = JSON.stringify(obj)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    const store = openPushStore(dir)
    t.is(store.available(), false, name + ': unavailable')
    await rejects(t, store.put(sub(m, 9)), 'indisponivel', name + ': put refused')
    await rejects(t, store.remove({ member: m, endpoint: ep(1) }), 'indisponivel', name + ': remove refused')
    await rejects(t, store.removeAll(m), 'indisponivel', name + ': removeAll refused')
    t.exception(() => store.list(m), name + ': list refused')
    t.exception(() => store.count(), name + ': count refused')
    t.is(await store.heal(), false, name + ': heal does nothing')
    t.is(fs.readFileSync(file, 'utf8'), bytes, name + ': never rewritten')
  }
  const { dir, file } = setup(t)
  fs.writeFileSync(file, '{not json', { mode: 0o600 })
  const store = openPushStore(dir)
  t.is(store.available(), false, 'bad JSON: unavailable')
  await rejects(t, store.put(sub(m, 9)), 'indisponivel', 'bad JSON: put refused')
  t.is(fs.readFileSync(file, 'utf8'), '{not json', 'bad JSON: never rewritten')
})

test('a file replaced by a tampered one after open marks the store unavailable', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  const obj = readFile(file)
  obj.members[m][0].auth = b64u(Buffer.alloc(17, 2))
  replaceUnder(file, obj)
  const bytes = fs.readFileSync(file, 'utf8')
  await rejects(t, store.put(sub(m, 2)), 'indisponivel', 'put refused')
  t.is(store.available(), false)
  t.is(fs.readFileSync(file, 'utf8'), bytes, 'never rewritten')
})

test('readOnly never creates the file', async (t) => {
  const { store, file } = setup(t, { readOnly: true })
  const m = memberKey()
  await rejects(t, store.put(sub(m, 1)), 'indisponivel', 'put refused')
  await rejects(t, store.remove({ member: m, endpoint: ep(1) }), 'indisponivel', 'remove refused')
  await rejects(t, store.removeAll(m), 'indisponivel', 'removeAll refused')
  t.is(await store.heal(), false)
  t.absent(fs.existsSync(file), 'no file')
  t.alike(store.list(m), [])
  t.is(store.count(), 0)
})

test('guard() false refuses that request only and leaves the file unchanged', async (t) => {
  let ok = true
  const { store, file } = setup(t, { guard: () => ok })
  const m = memberKey()
  await store.put(sub(m, 1))
  const before = fs.readFileSync(file, 'utf8')
  ok = false
  await rejects(t, store.put(sub(m, 2)), 'indisponivel', 'guard refused the put')
  await rejects(t, store.remove({ member: m, endpoint: ep(1) }), 'indisponivel', 'guard refused the remove')
  t.is(fs.readFileSync(file, 'utf8'), before, 'file unchanged')
  t.is(store.devices(m), 1, 'memory unchanged')
  ok = true
  t.alike(await store.put(sub(m, 2)), { changed: true }, 'the guard back, put succeeds')
  t.is(store.available(), true)
})

test('guard() true before and false after the write does not acknowledge', async (t) => {
  let calls = 0
  let failAt = -1
  const { store, file } = setup(t, { guard: () => ++calls !== failAt })
  const m = memberKey()
  await store.put(sub(m, 1))
  failAt = calls + 2
  await rejects(t, store.put(sub(m, 2)), 'indisponivel', 'not acknowledged after the guard failed')
  t.is(readFile(file).members[m].length, 2, 'the write itself landed')
  t.alike(await store.put(sub(m, 2)), { changed: false }, 'the repeat answers')
})

test('fail() refuses later writes', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  store.fail()
  t.is(store.available(), false)
  await rejects(t, store.put(sub(m, 1)), 'indisponivel', 'put refused')
})

test('MAX_MEMBERS is the documented admission cap', async (t) => {
  t.is(MAX_MEMBERS, 100000)
})

test('an external replacement missing an acknowledged row is healed', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.put(sub(a, 1))
  replaceUnder(file, validFile(b, [2]))
  t.is(await store.heal(), true, 'heal wrote')
  t.alike(Object.keys(readFile(file).members).sort(), [a, b].sort(), 'union of disk and memory')
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.is(store.count(), 2)
  t.is(await store.heal(), false, 'nothing more to heal')
})

test('a removed row does not come back when a stale file is renamed over push.json', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  await store.put(sub(m, 2))
  const stale = readFile(file)
  t.alike(await store.remove({ member: m, endpoint: ep(1) }), { changed: true })
  replaceUnder(file, stale)
  t.is(await store.heal(), true, 'heal rewrote the stale file')
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2)], 'still removed in memory')
  t.alike(readFile(file).members[m].map((r) => r.endpoint), [ep(2)], 'still removed on disk')

  replaceUnder(file, stale)
  t.is(await store.heal(), true, 'a second late rename is healed too')
  t.alike(readFile(file).members[m].map((r) => r.endpoint), [ep(2)], 'tombstones survive heal()')

  replaceUnder(file, stale)
  t.alike(await store.put(sub(m, 3)), { changed: true }, 'a put re-reads and drops the removed row as well')
  t.alike(readFile(file).members[m].map((r) => r.endpoint), [ep(2), ep(3)])

  t.alike(await store.put(sub(m, 1)), { changed: true }, 'a later put of the same endpoint brings it back')
  replaceUnder(file, stale)
  await store.heal()
  t.ok(store.list(m).some((r) => r.endpoint === ep(1)), 'the tombstone was cleared by the put')
})

test('a removeAll survives a stale file', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  await store.put(sub(m, 2))
  const stale = readFile(file)
  await store.removeAll(m)
  replaceUnder(file, stale)
  await store.heal()
  t.is(store.devices(m), 0)
  t.alike(readFile(file).members, {})
})

test('concurrent puts serialize', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await Promise.all([1, 2, 3].map((n) => store.put(sub(m, n))))
  t.is(store.devices(m), 3)
  t.is(readFile(file).members[m].length, 3)
})

test('a failed write leaves the store dirty and the next write rewrites', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
  try {
    await store.put(sub(m, 2))
    t.fail('resolved')
  } catch (err) {
    t.is(err.code, 'EIO', 'the write error propagates')
  }
  fs.renameSync = renameSync
  t.is(readFile(file).members[m].length, 1, 'the file holds the previous state')
  t.is(store.available(), true)
  t.is(await store.heal(), true, 'dirty: heal writes')
})

function rowAt (n, ms, fill = 1) {
  return { endpoint: ep(n), p256dh: p256dh(fill), auth: auth(), createdAt: new Date(ms).toISOString() }
}

test('a row the cap evicts in a merge gets a tombstone', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  for (let n = 1; n <= 4; n++) {
    await store.put(sub(m, n))
    c.t += MIN
  }
  const stale = readFile(file)
  replaceUnder(file, { v: 1, members: { [m]: [2, 3, 4, 5].map((n) => rowAt(n, T0 + (10 + n) * MIN)) } })
  t.is(await store.heal(), false, 'the union of 1-5 capped equals the file')
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2), ep(3), ep(4), ep(5)])
  await store.remove({ member: m, endpoint: ep(5) })
  replaceUnder(file, stale)
  await store.heal()
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2), ep(3), ep(4)], 'device-1 stays evicted')
  t.alike(readFile(file).members[m].map((r) => r.endpoint), [ep(2), ep(3), ep(4)])
})

test('an update after the clock moved back still beats the stale copy', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  c.t = T0 + 10 * MIN
  await store.put(sub(m, 1))
  const stale = readFile(file)
  c.t = T0
  t.alike(await store.put(sub(m, 1, { p256dh: p256dh(7), auth: auth(8) })), { changed: true })
  t.ok(readFile(file).members[m][0].createdAt > stale.members[m][0].createdAt, 'createdAt moved forward')
  replaceUnder(file, stale)
  await store.heal()
  t.alike(store.list(m), [{ endpoint: ep(1), p256dh: p256dh(7), auth: auth(8) }], 'the acknowledged keys stay')
  t.is(readFile(file).members[m][0].p256dh, p256dh(7))
})

test('a failed write changes neither memory nor tombstones', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  c.t += MIN
  await store.put(sub(m, 2))
  const stale = readFile(file)
  c.t += MIN
  await store.remove({ member: m, endpoint: ep(1) })
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
  await rejects(t, store.put(sub(m, 1, { p256dh: p256dh(9) })), 'EIO', 'the re-put fails')
  await rejects(t, store.remove({ member: m, endpoint: ep(2) }), 'EIO', 'the remove fails')
  fs.renameSync = renameSync
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2)], 'memory as before both calls')
  replaceUnder(file, stale)
  t.is(await store.heal(), true)
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2)], 'the stale file does not bring device-1 back')
  t.alike(readFile(file).members[m].map((r) => r.endpoint), [ep(2)])
})

test('a tombstone does not hide a newer registration of the same endpoint', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.put(sub(m, 1))
  await store.remove({ member: m, endpoint: ep(1) })
  replaceUnder(file, { v: 1, members: { [m]: [rowAt(1, T0 + 5 * MIN, 7)] } })
  c.t += 6 * MIN
  await store.heal()
  t.alike(store.list(m), [{ endpoint: ep(1), p256dh: p256dh(7), auth: auth() }], 'the later registration is kept')
  t.alike(Object.keys(readFile(file).members), [m], 'and written back')
})

test('the cap in put keeps the new row even when the clock moved back', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  c.t = T0 + 10 * MIN
  for (let n = 1; n <= 4; n++) {
    await store.put(sub(m, n))
    c.t += MIN
  }
  c.t = T0
  t.alike(await store.put(sub(m, 5)), { changed: true })
  t.alike(store.list(m).map((r) => r.endpoint), [ep(2), ep(3), ep(4), ep(5)], 'the oldest saved row is evicted')
  const rows = readFile(file).members[m].filter((r) => r.endpoint !== ep(2))
  replaceUnder(file, { v: 1, members: { [m]: [...rows, rowAt(6, T0 + 30 * MIN)] } })
  await store.heal()
  t.alike(store.list(m).map((r) => r.endpoint).sort(), [ep(3), ep(4), ep(5), ep(6)].sort(), 'a later merge keeps the acknowledged row')
})

test('moving an endpoint between members is accepted at MAX_MEMBERS', async (t) => {
  const { dir, file } = setup(t)
  const members = {}
  for (let i = 0; i < MAX_MEMBERS; i++) {
    members[i.toString(16).padStart(64, '0')] = [rowAt('m' + i, T0)]
  }
  fs.writeFileSync(file, JSON.stringify({ v: 1, members }), { mode: 0o600 })
  const store = openPushStore(dir, { now: () => T0 + MIN })
  const b = memberKey()
  await rejects(t, store.put(sub(b, 'new')), 'limite', 'a new member is refused at the cap')
  t.alike(await store.put(sub(b, 'm0')).catch((err) => err.code), { changed: true }, 'a transfer that keeps the count is accepted')
  t.is(store.devices(b), 1)
  t.is(store.count(), MAX_MEMBERS)
})
