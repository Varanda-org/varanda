'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { endpointHash } = require('@varanda/core/lib/push-proof')
const { openPushCapsStore, validCaps, FILE, MAX_BYTES } = require('../lib/account/push-caps-store')
const { tmpDir } = require('./helpers/net')

const MEMBER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const HASH = 'c'.repeat(64)
const caps = ['seen-sync']

test('push caps: separate atomic file, canonical rows, copies, removal and stale readers', async (t) => {
  const dir = tmpDir(t)
  const store = openPushCapsStore(dir)
  const stale = openPushCapsStore(dir)
  t.absent(fs.existsSync(path.join(dir, FILE)))
  t.alike(await store.put({ member: MEMBER, hash: HASH, caps }), { changed: true })
  t.is(fs.statSync(path.join(dir, FILE)).mode & 0o777, 0o600)
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, FILE))), { v: 1, members: { [MEMBER]: { [HASH]: caps } } })
  const copy = store.get(MEMBER, HASH)
  copy.length = 0
  t.alike(store.get(MEMBER, HASH), caps)
  t.alike(await stale.put({ member: OTHER, hash: HASH, caps }), { changed: true })
  t.alike(store.get(OTHER, HASH), caps)
  await store.remove({ member: MEMBER, hash: HASH })
  await stale.put({ member: OTHER, hash: HASH, caps })
  t.alike(stale.get(MEMBER, HASH), [], 'stale memory never resurrects a capability')
  await store.removeAll(OTHER)
  t.absent(openPushCapsStore(dir).holds(OTHER))
  t.alike(await store.removeAll(OTHER), { changed: false })
})

test('push caps: only an exact capability list and bounded canonical keys are accepted', async (t) => {
  const store = openPushCapsStore(tmpDir(t))
  for (const bad of [null, {}, 'seen-sync', ['unknown'], ['seen-sync', 'seen-sync'], [1], ['seen-sync', 'unknown']]) {
    t.absent(validCaps(bad))
    await t.exception.all(() => store.put({ member: MEMBER, hash: HASH, caps: bad }), TypeError)
  }
  for (const [member, hash] of [['x', HASH], [MEMBER, 'x'], [MEMBER, undefined]]) {
    await t.exception.all(() => store.put({ member, hash, caps }), TypeError)
  }
  for (let i = 0; i < 4; i++) await store.put({ member: MEMBER, hash: String(i).repeat(64), caps })
  await t.exception(store.put({ member: MEMBER, hash: HASH, caps }), { code: 'limite' })
  t.alike(store.get(MEMBER, HASH), [])
  await store.put({ member: MEMBER, hash: '0'.repeat(64), caps: [] })
  await store.put({ member: MEMBER, hash: HASH, caps })
  t.alike(store.get(MEMBER, HASH), caps)
})

test('push caps: unknown keys, malformed files, symlinks and oversized files fail closed without replacement', async (t) => {
  for (const state of [
    { v: 2, members: {} },
    { v: 1, members: {}, extra: true },
    { v: 1, members: { [MEMBER]: { [HASH]: ['unknown'] } } },
    { v: 1, members: { [MEMBER]: {} } },
    { v: 1, members: { [MEMBER]: { [HASH]: [] } } },
    { v: 1, members: { wrong: { [HASH]: caps } } }
  ]) {
    const dir = tmpDir(t)
    const file = path.join(dir, FILE)
    const text = JSON.stringify(state)
    fs.writeFileSync(file, text)
    const store = openPushCapsStore(dir)
    t.absent(store.available())
    await t.exception(() => store.get(MEMBER, HASH), { code: 'indisponivel' })
    await t.exception(store.removeAll(MEMBER), { code: 'indisponivel' })
    t.is(fs.readFileSync(file, 'utf8'), text)
  }
  const dir = tmpDir(t)
  const file = path.join(dir, FILE)
  fs.writeFileSync(file, '')
  fs.truncateSync(file, MAX_BYTES + 1)
  t.absent(openPushCapsStore(dir).available())
  fs.unlinkSync(file)
  const target = path.join(dir, 'target.json')
  fs.writeFileSync(target, JSON.stringify({ v: 1, members: {} }))
  fs.symlinkSync(target, file)
  t.absent(openPushCapsStore(dir).available())
  t.ok(fs.lstatSync(file).isSymbolicLink())
})

test('push caps: read-only, lost guards and a failed rename preserve the file and future writes', async (t) => {
  const dir = tmpDir(t)
  const store = openPushCapsStore(dir)
  await store.put({ member: MEMBER, hash: HASH, caps })
  const file = path.join(dir, FILE)
  const before = fs.readFileSync(file, 'utf8')
  await t.exception(openPushCapsStore(dir, { readOnly: true }).removeAll(MEMBER), { code: 'indisponivel' })
  for (const guard of [() => false, () => { throw new Error('guard') }]) {
    await t.exception(openPushCapsStore(dir, { guard }).removeAll(MEMBER), { code: 'indisponivel' })
  }
  let calls = 0
  await t.exception(openPushCapsStore(dir, { guard: () => ++calls < 2 }).removeAll(MEMBER), { code: 'indisponivel' })
  t.is(fs.readFileSync(file, 'utf8'), before, 'guard rechecked before rename')
  t.alike(fs.readdirSync(dir), [FILE], 'temporary file cleaned')
  const rename = fs.renameSync
  try {
    fs.renameSync = () => { throw new Error('disk') }
    await t.exception(store.removeAll(MEMBER), { code: 'indisponivel' })
  } finally {
    fs.renameSync = rename
  }
  t.is(fs.readFileSync(file, 'utf8'), before)
  await store.removeAll(MEMBER)
  t.absent(store.holds(MEMBER))
})

test('push caps: prune erases evicted and transferred subscription rows', async (t) => {
  const store = openPushCapsStore(tmpDir(t))
  const endpoint = 'https://fcm.googleapis.com/one'
  const hash = endpointHash(endpoint)
  await store.put({ member: MEMBER, hash, caps })
  await store.put({ member: OTHER, hash: HASH, caps })
  await store.prune([{ member: MEMBER, endpoint }])
  t.alike(store.get(MEMBER, hash), caps)
  t.absent(store.holds(OTHER))
  await store.prune([{ member: OTHER, endpoint }])
  t.absent(store.holds(MEMBER))
  t.absent(store.holds(OTHER), 'capability does not follow a transferred endpoint')
})
