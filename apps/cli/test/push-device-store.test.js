'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const test = require('brittle')
const {
  openPushDeviceStore, FILE, PUSH_DEVICE_MAX_PER_MEMBER, MAX_MEMBERS,
  TOMBSTONE_MAX, validTransport, validToken, validKey
} = require('../lib/account/push-device-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-29T12:00:00.000Z')
const MIN = 60000
const memberKey = () => randomBytes(32).toString('hex')
const deviceKey = () => randomBytes(16).toString('base64url')

function row (extra = {}) {
  return { transport: 'fcm', token: randomBytes(32).toString('hex'), key: deviceKey(), createdAt: T0, ...extra }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fileState (member, rows) {
  return { v: 1, members: { [member]: rows } }
}

function replaceUnder (file, obj) {
  const tmp = file + '.stale'
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const webFile = path.join(dir, 'push.json')
  const webMember = memberKey()
  const webBytes = Buffer.from(JSON.stringify(fileState(webMember, Array.from({ length: 4 }, () => ({
    endpoint: 'https://example.com/' + randomBytes(16).toString('hex'),
    p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    createdAt: new Date(T0).toISOString()
  }))), null, 2) + '\n')
  fs.writeFileSync(webFile, webBytes, { mode: 0o600 })
  const c = { t: T0, now: () => c.t }
  const unchanged = () => t.ok(fs.readFileSync(webFile).equals(webBytes), 'Web Push file is byte-identical')
  const open = (more = {}) => {
    unchanged()
    const raw = openPushDeviceStore(dir, { now: c.now, ...opts, ...more })
    unchanged()
    // Check every method, including failures and reads, to catch accidental
    // coupling to the existing Web Push sidecar anywhere in the API.
    return Object.fromEntries(Object.entries(raw).map(([name, method]) => [name, (...args) => {
      unchanged()
      try {
        const result = method(...args)
        if (result && typeof result.then === 'function') return result.finally(unchanged)
        unchanged()
        return result
      } catch (err) {
        unchanged()
        throw err
      }
    }]))
  }
  return { dir, file: path.join(dir, FILE), webFile, webMember, c, open, store: open() }
}

async function rejects (t, promise, code) {
  try {
    await promise
    t.fail('request resolved')
  } catch (err) {
    t.is(err.code, code, 'expected error code')
  }
}

test('add, list, remove and reopen round trip with mode 0600', async (t) => {
  const { store, file, open } = setup(t)
  const m = memberKey()
  const r = row({ transport: 'apns' })
  t.is(FILE, 'push-devices.json')
  t.absent(fs.existsSync(file), 'open writes nothing')
  t.alike(store.list(m), [])
  t.alike(await store.add(m, r), { changed: true })
  t.alike(store.list(m), [r])
  t.alike(readFile(file), fileState(m, [r]))
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.alike(open().list(m), [r])
  t.alike(await store.remove(m, r.key), { changed: true })
  t.alike(await store.remove(m, r.key), { changed: false })
  t.alike(readFile(file).members, {})
})

test('a fifth native row evicts the oldest independently of Web Push rows', async (t) => {
  const { store, c, webMember: m, file } = setup(t)
  const rows = []
  for (let i = 0; i < 5; i++) {
    rows.push(row({ createdAt: c.t }))
    await store.add(m, rows[i])
    c.t += MIN
  }
  t.is(PUSH_DEVICE_MAX_PER_MEMBER, 4)
  t.alike(store.list(m), rows.slice(1))
  const stale = fileState(m, rows.slice(0, 4))
  replaceUnder(file, stale)
  await store.heal()
  t.alike(store.list(m), rows.slice(1), 'evicted row stays buried')
})

test('rotation keeps one row and stale removeToken cannot remove it', async (t) => {
  const { store, c, open } = setup(t)
  const m = memberKey()
  const first = row()
  await store.add(m, first)
  t.alike(await store.add(m, first), { changed: false })
  c.t += MIN
  const rotated = row({ key: first.key, createdAt: c.t })
  t.alike(await store.add(m, rotated), { changed: true })
  t.alike(store.list(m), [rotated])
  t.alike(open().list(m), [rotated])
  t.is(await store.removeToken(m, first.transport, first.token, first.key, first.createdAt), false)
  t.is(await store.removeToken(memberKey(), rotated.transport, rotated.token, rotated.key, rotated.createdAt), false)
  t.alike(store.list(m), [rotated])
  t.is(await store.removeToken(m, rotated.transport, rotated.token, rotated.key, rotated.createdAt), true)
  t.is(await store.removeToken(m, rotated.transport, rotated.token, rotated.key, rotated.createdAt), false)
  t.is(store.count(), 0)
})

test('late removeToken preserves a re-registration with a new key or generation', async (t) => {
  const { store, c, open } = setup(t)
  const m = memberKey()
  const first = row()
  await store.add(m, first)
  c.t += MIN
  const replacement = { ...first, key: deviceKey(), createdAt: c.t }
  await open().add(m, replacement)
  t.is(await store.removeToken(m, first.transport, first.token, first.key, first.createdAt), false)
  t.alike(store.list(m), [replacement])
  t.is(await store.removeToken(m, first.transport, first.token, first.key, replacement.createdAt), false, 'device key must match')
  t.alike(store.list(m), [replacement])
  await store.remove(m, replacement.key)
  c.t += MIN
  const renewed = { ...replacement, createdAt: c.t }
  await store.add(m, renewed)
  t.is(await store.removeToken(m, replacement.transport, replacement.token, replacement.key, replacement.createdAt), false, 'generation must match')
  t.alike(store.list(m), [renewed])
  t.alike(open().list(m), [renewed])
  t.is(await store.removeToken(m, renewed.transport, renewed.token, renewed.key, renewed.createdAt), true)
})

test('removeToken re-reads a rotation made by another holder', async (t) => {
  const { store, open, c } = setup(t)
  const m = memberKey()
  const first = row()
  await store.add(m, first)
  c.t += MIN
  const rotated = row({ key: first.key, createdAt: c.t })
  await open().add(m, rotated)
  t.is(await store.removeToken(m, first.transport, first.token, first.key, first.createdAt), false)
  t.alike(store.list(m), [rotated])
})

test('a token moves to another member only with the same device key', async (t) => {
  const { store, c, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const first = row()
  await store.add(a, first)
  const stale = readFile(file)
  c.t += MIN
  const before = fs.readFileSync(file)
  await rejects(t, store.add(b, { ...first, key: deviceKey(), createdAt: c.t }), 'pedido-invalido')
  t.alike(store.list(a), [first])
  t.alike(store.list(b), [])
  t.ok(fs.readFileSync(file).equals(before), 'refusal leaves the file unchanged')
  const moved = { ...first, createdAt: c.t }
  await store.add(b, moved)
  t.alike(store.list(a), [])
  t.alike(store.list(b), [moved])
  t.is(await store.removeToken(a, first.transport, first.token, first.key, first.createdAt), false)
  c.t += MIN
  const rekeyed = { ...moved, key: deviceKey(), createdAt: c.t }
  await store.add(b, rekeyed)
  t.alike(store.list(b), [rekeyed])
  t.is(store.count(), 1)
  await store.removeMember(b)
  replaceUnder(file, stale)
  await store.heal()
  t.is(store.count(), 0, 'the old owner remains buried')
})

test('rotation into an owned token removes both replaced rows', async (t) => {
  for (const sameMember of [true, false]) {
    const { store, c } = setup(t)
    const a = memberKey()
    const b = sameMember ? a : memberKey()
    const first = row()
    const second = row(sameMember ? {} : { key: first.key })
    await store.add(a, first)
    await store.add(b, second)
    c.t += MIN
    const rotated = { ...second, key: first.key, createdAt: c.t }
    await store.add(a, rotated)
    t.alike(store.list(a), [rotated])
    t.is(store.count(), 1)
  }
})

test('token identity includes transport and device keys are scoped by member', async (t) => {
  const { store } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const first = row({ transport: 'apns' })
  const second = { ...first, transport: 'fcm' }
  await store.add(a, first)
  await store.add(b, second)
  t.is(store.count(), 2)
  t.is(await store.removeToken(a, 'fcm', first.token, first.key, first.createdAt), false)
  t.is(await store.removeToken(a, 'apns', first.token, first.key, first.createdAt), true)
  t.alike(store.list(b), [second])
})

test('removeMember clears only that member and survives stale files', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.add(a, row())
  await store.add(a, row())
  await store.add(b, row())
  const stale = readFile(file)
  t.alike(await store.removeMember(a), { changed: true })
  t.alike(await store.removeMember(a), { changed: false })
  replaceUnder(file, stale)
  await store.heal()
  t.is(store.devices(a), 0)
  t.is(store.devices(b), 1)
  t.alike(Object.keys(readFile(file).members), [b])
})

test('list and all return copies; devices and count include every member', async (t) => {
  const { store } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const first = row()
  const second = row()
  await store.add(a, first)
  await store.add(b, second)
  t.alike(store.all(), [{ member: a, ...first }, { member: b, ...second }])
  const listed = store.list(a)
  listed[0].token = 'changed'
  listed.push(row())
  store.all()[0].key = deviceKey()
  t.alike(store.list(a), [first])
  t.is(store.devices(a), 1)
  t.is(store.devices(memberKey()), 0)
  t.is(store.count(), 2)
})

test('validators enforce sender token shapes and canonical 16-byte keys', (t) => {
  t.ok(validTransport('apns'))
  t.ok(validTransport('fcm'))
  for (const value of ['', 'APNS', null, {}, 1]) t.absent(validTransport(value))
  for (const n of [64, 65, 200]) t.ok(validToken('apns', 'a'.repeat(n)))
  for (const value of ['', 'a'.repeat(63), 'a'.repeat(201), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n', null]) {
    t.absent(validToken('apns', value))
  }
  for (const value of ['a', 'A-z_0:9', 'x'.repeat(4096)]) t.ok(validToken('fcm', value))
  for (const value of ['', 'x'.repeat(4097), 'abc=', 'ab/c', 'ab+c', 'abc\n', 'a b', null]) {
    t.absent(validToken('fcm', value))
  }
  t.absent(validToken('web', 'abc'))
  t.ok(validKey(deviceKey()))
  const canonical = Buffer.alloc(16).toString('base64url')
  for (const value of [null, '', canonical + '=', canonical.slice(0, -1), canonical.slice(0, -1) + 'B', canonical.slice(0, -1) + '\n', '+'.repeat(22), randomBytes(17).toString('base64url')]) {
    t.absent(validKey(value))
  }
})

test('invalid arguments fail without echoing the supplied token or key', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const good = row()
  const invalid = [null, [], {}, { ...good, extra: true }, { ...good, transport: 'web' }, { ...good, token: good.token + '\n' }, { ...good, key: good.key + '=' }, { ...good, createdAt: 1.5 }, { ...good, createdAt: Infinity }, { ...good, createdAt: String(T0) }]
  const calls = invalid.map((r) => () => store.add(m, r))
  calls.push(() => store.add('AB'.repeat(32), good), () => store.remove(m, good.key + '='), () => store.removeToken(m, 'apns', 'bad', good.key, good.createdAt), () => store.removeMember('bad'))
  for (const call of calls) {
    try {
      await call()
      t.fail('invalid argument accepted')
    } catch (err) {
      t.ok(err instanceof TypeError)
      t.absent(err.message.includes(good.token))
      t.absent(err.message.includes(good.key))
    }
  }
  t.exception.all(() => store.list('bad'))
  t.exception.all(() => store.devices('bad'))
  t.is(store.count(), 0)
})

test('a queued add snapshots the input row', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const input = row()
  const expected = { ...input }
  const pending = store.add(m, input)
  input.token = 'changed'
  input.extra = true
  await pending
  t.alike(store.list(m), [expected])
})

test('malformed files fail closed and are never rewritten', async (t) => {
  const m = memberKey()
  const good = row()
  const cases = [
    '{not json', 'null', '[]',
    { v: 2, members: {} }, { v: 1, members: {}, extra: true }, { v: 1, members: [] },
    fileState('bad', [good]), fileState(m, []), fileState(m, {}),
    fileState(m, [good, { ...row(), key: good.key }]),
    fileState(m, [good, { ...row(), token: good.token }]),
    { v: 1, members: { [m]: [good], [memberKey()]: [{ ...good, key: deviceKey() }] } },
    fileState(m, Array.from({ length: 5 }, () => row()))
  ]
  for (const patch of [{ extra: true }, { token: 'bad token' }, { transport: 'web' }, { key: good.key + '=' }, { createdAt: 'yesterday' }, { createdAt: 0.5 }, { createdAt: null }]) {
    cases.push(fileState(m, [{ ...good, ...patch }]))
  }
  for (const key of Object.keys(good)) {
    const missing = { ...good }
    delete missing[key]
    cases.push(fileState(m, [missing]))
  }
  for (const obj of cases) {
    const { file, open } = setup(t)
    const bytes = typeof obj === 'string' ? obj : JSON.stringify(obj)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    const store = open()
    t.is(store.available(), false)
    await rejects(t, store.add(m, good), 'indisponivel')
    await rejects(t, store.remove(m, good.key), 'indisponivel')
    await rejects(t, store.removeToken(m, good.transport, good.token, good.key, good.createdAt), 'indisponivel')
    await rejects(t, store.removeMember(m), 'indisponivel')
    for (const call of [() => store.list(m), () => store.all(), () => store.devices(m), () => store.count()]) t.exception(call)
    t.is(await store.heal(), false)
    t.is(fs.readFileSync(file, 'utf8'), bytes)
  }
})

test('a malformed replacement after open makes the store unavailable', async (t) => {
  for (const heal of [false, true]) {
    const { store, file } = setup(t)
    const m = memberKey()
    await store.add(m, row())
    replaceUnder(file, { v: 1, members: {}, extra: true })
    const bytes = fs.readFileSync(file)
    if (heal) t.is(await store.heal(), false)
    else await rejects(t, store.add(m, row()), 'indisponivel')
    t.is(store.available(), false)
    t.ok(fs.readFileSync(file).equals(bytes))
  }
})

test('readOnly and fail refuse mutations', async (t) => {
  for (const readOnly of [true, false]) {
    const { store, file } = setup(t, { readOnly })
    const m = memberKey()
    const r = row()
    if (!readOnly) store.fail()
    await rejects(t, store.add(m, r), 'indisponivel')
    await rejects(t, store.remove(m, r.key), 'indisponivel')
    await rejects(t, store.removeToken(m, r.transport, r.token, r.key, r.createdAt), 'indisponivel')
    await rejects(t, store.removeMember(m), 'indisponivel')
    t.is(await store.heal(), false)
    t.absent(fs.existsSync(file))
    t.is(store.available(), readOnly)
    if (readOnly) t.alike(store.list(m), [])
    else t.exception(() => store.all())
  }
})

test('guard refusal before a write affects only that request', async (t) => {
  let held = true
  const { store, file } = setup(t, { guard: () => held })
  const m = memberKey()
  const first = row()
  await store.add(m, first)
  const bytes = fs.readFileSync(file)
  held = false
  await rejects(t, store.add(m, row()), 'indisponivel')
  await rejects(t, store.remove(m, first.key), 'indisponivel')
  t.ok(fs.readFileSync(file).equals(bytes))
  t.alike(store.list(m), [first])
  held = true
  t.alike(await store.add(m, row()), { changed: true })
  t.is(store.available(), true)
})

test('takeover before rename preserves the new holder file and removes the temp', async (t) => {
  let calls = 0
  let takeoverAt = -1
  const { store, file, dir } = setup(t, {
    guard: () => {
      if (++calls !== takeoverAt) return true
      replaceUnder(file, replacement)
      return false
    }
  })
  const a = memberKey()
  const b = memberKey()
  const first = row()
  const other = row()
  await store.add(a, first)
  const replacement = fileState(b, [other])
  takeoverAt = calls + 2
  await rejects(t, store.remove(a, first.key), 'indisponivel')
  t.alike(readFile(file), replacement)
  t.alike(store.list(a), [first])
  t.absent(fs.readdirSync(dir).some((n) => n.endsWith('.tmp')))
  t.is(store.available(), true)
  t.is(await store.heal(), true)
  t.is(store.count(), 2, 'refused removal did not commit a tombstone')
})

test('guard refusal after rename does not acknowledge or change memory', async (t) => {
  let calls = 0
  let failAt = -1
  const { store, file } = setup(t, { guard: () => ++calls !== failAt })
  const m = memberKey()
  const first = row()
  const second = row()
  await store.add(m, first)
  failAt = calls + 3
  await rejects(t, store.add(m, second), 'indisponivel')
  t.is(readFile(file).members[m].length, 2, 'write landed')
  t.alike(store.list(m), [first])
  t.alike(await store.add(m, second), { changed: false })
  t.is(store.devices(m), 2)
})

test('concurrent adds serialize and different holders merge disk state', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  const other = open()
  await Promise.all([store.add(m, row()), store.add(m, row()), other.add(m, row())])
  await store.heal()
  t.is(store.devices(m), 3)
  t.is(open().devices(m), 3)
})

test('healing restores acknowledged rows missing from an external replacement', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const first = row()
  const second = row()
  await store.add(a, first)
  replaceUnder(file, fileState(b, [second]))
  t.is(await store.heal(), true)
  t.alike(store.list(a), [first])
  t.alike(store.list(b), [second])
  t.is(await store.heal(), false)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
})

test('removal tombstones survive repeated heals and permit later registrations', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  const first = row()
  await store.add(m, first)
  const stale = readFile(file)
  await store.remove(m, first.key)
  for (let i = 0; i < 2; i++) {
    replaceUnder(file, stale)
    t.is(await store.heal(), true)
    t.is(store.count(), 0)
  }
  const newer = { ...first, createdAt: T0 + MIN }
  replaceUnder(file, fileState(m, [newer]))
  await store.heal()
  t.alike(store.list(m), [newer])
  await store.remove(m, newer.key)
  c.t = T0 - MIN
  await store.add(m, first)
  t.ok(store.list(m)[0].createdAt > newer.createdAt)
})

test('rotation beats stale copies even after the clock moves back', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  c.t += 10 * MIN
  const first = row()
  await store.add(m, first)
  const stale = readFile(file)
  c.t = T0
  const rotated = row({ key: first.key })
  await store.add(m, rotated)
  const current = store.list(m)
  t.ok(current[0].createdAt > stale.members[m][0].createdAt)
  replaceUnder(file, stale)
  await store.heal()
  t.alike(store.list(m), current)
  t.is(await store.removeToken(m, first.transport, first.token, first.key, first.createdAt), false)
  await store.remove(m, first.key)
  replaceUnder(file, stale)
  await store.heal()
  t.is(store.count(), 0)
})

test('the cap preserves a newly added row after the clock moves back', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  const rows = Array.from({ length: 5 }, () => row())
  c.t += 10 * MIN
  for (const r of rows.slice(0, 4)) {
    await store.add(m, r)
    c.t += MIN
  }
  c.t = T0
  await store.add(m, rows[4])
  t.alike(store.list(m).map((r) => r.key), rows.slice(1).map((r) => r.key))
})

test('rows evicted during merge remain buried after the winner leaves', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  const rows = Array.from({ length: 5 }, (_, i) => row({ createdAt: T0 + i * MIN }))
  for (const r of rows.slice(0, 4)) await store.add(m, r)
  const stale = readFile(file)
  const newer = rows.slice(1).map((r) => ({ ...r, createdAt: r.createdAt + 10 * MIN }))
  replaceUnder(file, fileState(m, newer))
  t.is(await store.heal(), false, 'the capped union already equals disk')
  t.alike(store.list(m), newer)
  await store.remove(m, rows[4].key)
  replaceUnder(file, stale)
  c.t += 20 * MIN
  await store.heal()
  t.alike(store.list(m), newer.slice(0, 3))
})

test('token ownership merges bury either losing owner, including equal-date ties', async (t) => {
  for (const offset of [-MIN, 0, MIN]) {
    const { store, file } = setup(t)
    const a = memberKey()
    const b = memberKey()
    const first = row()
    const diskRow = { ...first, key: deviceKey(), createdAt: T0 + offset }
    await store.add(a, first)
    const stale = offset > 0 ? fileState(a, [first]) : fileState(b, [diskRow])
    replaceUnder(file, fileState(b, [diskRow]))
    await store.heal()
    const winner = offset > 0 ? b : a
    t.alike(store.all(), [{ member: winner, ...(offset > 0 ? diskRow : first) }])
    await store.removeMember(winner)
    replaceUnder(file, stale)
    await store.heal()
    t.is(store.count(), 0)
  }
})

test('a disk rotation is adopted and a same-generation conflict keeps memory', async (t) => {
  for (const offset of [0, MIN]) {
    const { store, file } = setup(t)
    const m = memberKey()
    const first = row()
    const rotated = row({ key: first.key, createdAt: T0 + offset })
    await store.add(m, first)
    replaceUnder(file, fileState(m, [rotated]))
    await store.heal()
    t.alike(store.list(m), [offset ? rotated : first])
    await store.removeMember(m)
    replaceUnder(file, fileState(m, [first]))
    await store.heal()
    t.is(store.count(), 0)
  }
})

test('failed writes preserve memory and tombstones and leave the store dirty', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const first = row()
  const second = row()
  await store.add(m, first)
  await store.add(m, second)
  const stale = readFile(file)
  await store.remove(m, first.key)
  const before = store.list(m)
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
  await rejects(t, store.add(m, first), 'EIO')
  await rejects(t, store.remove(m, second.key), 'EIO')
  fs.renameSync = renameSync
  t.alike(store.list(m), before)
  t.is(store.available(), true)
  t.is(await store.heal(), true, 'dirty state is rewritten even when disk agrees')
  replaceUnder(file, stale)
  await store.heal()
  t.alike(store.list(m), before, 'failed re-add did not clear the tombstone')
})

test('admission caps members but permits a transfer at the cap', async (t) => {
  const { file, open } = setup(t)
  t.is(MAX_MEMBERS, 100000)
  t.is(TOMBSTONE_MAX, 10000)
  const members = {}
  const sharedKey = deviceKey()
  for (let i = 0; i < MAX_MEMBERS; i++) {
    members[i.toString(16).padStart(64, '0')] = [{ transport: 'fcm', token: 'fixture:' + i, key: sharedKey, createdAt: T0 }]
  }
  fs.writeFileSync(file, JSON.stringify({ v: 1, members }), { mode: 0o600 })
  const store = open()
  const m = memberKey()
  await rejects(t, store.add(m, row()), 'limite')
  t.alike(await store.add(m, row({ token: 'fixture:0', key: sharedKey })), { changed: true })
  t.is(store.devices(m), 1)
  t.is(store.count(), MAX_MEMBERS)
})

test('opening does not create a directory and non-regular sidecars are refused', async (t) => {
  const root = tmpDir(t)
  const missing = path.join(root, 'missing')
  t.is(openPushDeviceStore(missing).count(), 0)
  t.absent(fs.existsSync(missing))
  for (const symlink of [false, true]) {
    const { file, open } = setup(t)
    if (symlink) {
      const target = path.join(root, 'target')
      fs.writeFileSync(target, JSON.stringify({ v: 1, members: {} }))
      fs.symlinkSync(target, file)
    } else fs.mkdirSync(file)
    const store = open()
    t.is(store.available(), false)
    await rejects(t, store.add(memberKey(), row()), 'indisponivel')
    t.is(await store.heal(), false)
    t.is(fs.lstatSync(file).isSymbolicLink(), symlink)
  }
})

test('the native store never reads the Web Push sidecar', async (t) => {
  const { dir, webFile } = setup(t)
  const { readFileSync } = fs
  let webReads = 0
  t.teardown(() => { fs.readFileSync = readFileSync }, { force: true })
  fs.readFileSync = (file, ...args) => {
    if (file === webFile) webReads++
    return readFileSync(file, ...args)
  }
  const store = openPushDeviceStore(dir)
  const m = memberKey()
  const first = row()
  await store.add(m, first)
  await store.heal()
  store.list(m)
  store.all()
  store.devices(m)
  store.count()
  await store.removeToken(m, first.transport, first.token, first.key, first.createdAt)
  await store.remove(m, first.key)
  await store.removeMember(m)
  openPushDeviceStore(dir)
  fs.readFileSync = readFileSync
  t.is(webReads, 0)
})

test('token ownership ties keep memory even when a disk rotation was visited first', async (t) => {
  const { store, file } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const first = row()
  const second = row({ createdAt: T0 + MIN })
  await store.add(a, first)
  await store.add(b, second)
  replaceUnder(file, fileState(a, [{ ...second, key: first.key }]))
  await store.heal()
  t.alike(store.list(a), [])
  t.alike(store.list(b), [second])
  await store.removeMember(b)
  replaceUnder(file, fileState(a, [first]))
  await store.heal()
  t.is(store.count(), 0, 'both generations of the losing device stay buried')
})
