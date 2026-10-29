'use strict'

// apps/cli/lib/account/age-store.js: the age.json sidecar where the account
// service records each member's verified age band. No network; the clock is
// injected and disk failures are simulated by wrapping fs functions.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openAgeStore, FILE, BANDS, METHODS } = require('../lib/account/age-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-29T12:00:00.000Z')
const HOUR = 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: T0, now: () => c.t }
  const open = (more = {}) => openAgeStore(dir, { now: c.now, ...opts, ...more })
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

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function stubRename (t, fn) {
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = function (from, to) { return fn(renameSync, from, to) }
  return () => { fs.renameSync = renameSync }
}

test('constants', (t) => {
  t.is(FILE, 'age.json')
  t.alike([...BANDS], ['16-17', '18+'])
  t.alike([...METHODS], ['didit'])
  t.ok(Object.isFrozen(BANDS))
  t.ok(Object.isFrozen(METHODS))
})

test('record, verified and get round trip; exact file shape and mode', async (t) => {
  const { store, file, dir } = setup(t)
  const m = memberKey()
  t.ok(store.available())
  t.absent(store.verified(m))
  t.is(store.get(m), null)
  t.alike(fs.readdirSync(dir), [], 'nothing written before the first record')
  const out = await store.record({ member: m, band: '18+', method: 'didit' })
  t.alike(out, { changed: true })
  t.ok(store.verified(m))
  t.alike(store.get(m), { band: '18+', method: 'didit', checkedAt: iso(T0) })
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  const json = readFile(file)
  t.alike(Object.keys(json).sort(), ['members', 'v'])
  t.alike(json, { v: 1, members: { [m]: { band: '18+', method: 'didit', checkedAt: iso(T0) } } })
  t.alike(Object.keys(json.members[m]).sort(), ['band', 'checkedAt', 'method'])
})

test('a repeat keeps the first record and does not write', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  await store.record({ member: m, band: '18+', method: 'didit' })
  let renames = 0
  stubRename(t, (rename, from, to) => {
    if (to === file) renames++
    return rename.call(fs, from, to)
  })
  c.t += HOUR
  const out = await store.record({ member: m, band: '18+', method: 'didit' })
  t.alike(out, { changed: false })
  t.is(renames, 0)
  t.is(store.get(m).checkedAt, iso(T0))
})

test('an explicit checkedAt is stored as given', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  await store.record({ member: m, band: '16-17', method: 'didit', checkedAt: iso(T0 - HOUR) })
  t.is(store.get(m).checkedAt, iso(T0 - HOUR))
})

test('bad argument shapes throw TypeError', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const bad = [
    { member: 'zz', band: '18+', method: 'didit' },
    { member: m.toUpperCase(), band: '18+', method: 'didit' },
    { member: m, band: '15', method: 'didit' },
    { member: m, band: '18+', method: 'other' },
    { member: m, band: '18+', method: 'didit', checkedAt: '2026-10-29' },
    { member: m, band: '18+', method: 'didit', checkedAt: 5 }
  ]
  for (const args of bad) {
    try {
      await store.record(args)
      t.fail('accepted ' + JSON.stringify(args))
    } catch (err) {
      t.ok(err instanceof TypeError)
    }
  }
  t.exception.all(() => store.get('nope'), TypeError)
  t.exception.all(() => store.verified(null), TypeError)
})

test('two openers on the same dir merge: both records survive, earliest wins', async (t) => {
  const { open, file, c } = setup(t)
  const a = open()
  const b = open()
  const x = memberKey()
  const y = memberKey()
  await a.record({ member: x, band: '18+', method: 'didit' })
  c.t += HOUR
  await b.record({ member: y, band: '16-17', method: 'didit' })
  const json = readFile(file)
  t.alike(Object.keys(json.members).sort(), [x, y].sort(), 'b kept a\'s record')
  t.ok(b.verified(x), 'b adopted a\'s record from disk')
  // a records x again later from its own view: the earlier one stays.
  c.t += HOUR
  const again = await b.record({ member: x, band: '18+', method: 'didit' })
  t.is(again.changed, false)
  t.is(readFile(file).members[x].checkedAt, iso(T0))
  // An earlier record replaces a later one.
  const out = await a.record({ member: y, band: '16-17', method: 'didit', checkedAt: iso(T0 - HOUR) })
  t.is(out.changed, true)
  t.is(readFile(file).members[y].checkedAt, iso(T0 - HOUR))
  t.ok(readFile(file).members[x], 'x still there')
})

test('a band conflict never promotes 16-17 to 18+', async (t) => {
  const { open, file, c } = setup(t)
  const a = open()
  const b = open()
  const m = memberKey()
  await a.record({ member: m, band: '16-17', method: 'didit' })
  c.t += HOUR
  const later = await b.record({ member: m, band: '18+', method: 'didit' })
  t.is(later.changed, false)
  t.is(readFile(file).members[m].band, '16-17')
  t.is(b.get(m).band, '16-17')
  // Same instant: the more protective band wins, whichever side has it.
  const n = memberKey()
  await a.record({ member: n, band: '18+', method: 'didit', checkedAt: iso(T0) })
  const tie = await b.record({ member: n, band: '16-17', method: 'didit', checkedAt: iso(T0) })
  t.is(tie.changed, true)
  t.is(readFile(file).members[n].band, '16-17')
  const back = await a.record({ member: n, band: '18+', method: 'didit', checkedAt: iso(T0) })
  t.is(back.changed, false)
  t.is(a.get(n).band, '16-17')
})

test('guard() false refuses and writes nothing', async (t) => {
  let allow = false
  const { store, file } = setup(t, { guard: () => allow })
  const m = memberKey()
  await rejects(t, store.record({ member: m, band: '18+', method: 'didit' }), 'indisponivel', 'refused')
  t.absent(fs.existsSync(file))
  t.absent(store.verified(m))
  t.ok(store.available(), 'one refusal does not wedge the store')
  allow = true
  await store.record({ member: m, band: '18+', method: 'didit' })
  t.ok(store.verified(m))
})

test('guard() true before and false after the write is not acknowledged', async (t) => {
  let calls = 0
  const { store } = setup(t, { guard: () => ++calls < 2 })
  const m = memberKey()
  await rejects(t, store.record({ member: m, band: '18+', method: 'didit' }), 'indisponivel', 'refused after write')
  t.absent(store.verified(m), 'not readable as verified')
})

test('a malformed file answers indisponivel on every method and stays untouched', async (t) => {
  const m = memberKey()
  const cases = [
    { v: 1, members: {}, extra: true },
    { v: 2, members: {} },
    { v: 1, members: [] },
    { v: 1, members: { [m]: { band: '15', method: 'didit', checkedAt: iso(T0) } } },
    { v: 1, members: { [m]: { band: '18+', method: 'x', checkedAt: iso(T0) } } },
    { v: 1, members: { [m]: { band: '18+', method: 'didit', checkedAt: '2026-10-29' } } },
    { v: 1, members: { [m]: { band: '18+', method: 'didit', checkedAt: iso(T0), sessionId: 'abc' } } },
    { v: 1, members: { ABC: { band: '18+', method: 'didit', checkedAt: iso(T0) } } }
  ]
  const raws = [...cases.map((c) => JSON.stringify(c)), 'not json {']
  for (const raw of raws) {
    const { file, open } = setup(t)
    fs.writeFileSync(file, raw)
    const store = open()
    t.absent(store.available(), raw)
    await rejects(t, store.record({ member: m, band: '18+', method: 'didit' }), 'indisponivel', 'record')
    t.exception(() => store.get(m), /indisponivel/)
    t.exception(() => store.verified(m), /indisponivel/)
    t.is(await store.heal(), false)
    t.is(fs.readFileSync(file, 'utf8'), raw, 'bytes unchanged')
  }
})

test('a malformed file appearing between records answers indisponivel', async (t) => {
  const { store, file } = setup(t)
  await store.record({ member: memberKey(), band: '18+', method: 'didit' })
  fs.writeFileSync(file, 'garbage')
  await rejects(t, store.record({ member: memberKey(), band: '18+', method: 'didit' }), 'indisponivel', 'record')
  t.absent(store.available())
  t.is(fs.readFileSync(file, 'utf8'), 'garbage')
})

test('readOnly never writes; open never creates the dir', async (t) => {
  const { store, file, open } = setup(t)
  const m = memberKey()
  const ro = open({ readOnly: true })
  await rejects(t, ro.record({ member: m, band: '18+', method: 'didit' }), 'indisponivel', 'readOnly')
  t.absent(fs.existsSync(file))
  t.is(await ro.heal(), false)
  await store.record({ member: m, band: '18+', method: 'didit' })
  t.ok(open({ readOnly: true }).verified(m), 'readOnly reads the file')
  const missing = path.join(tmpDir(t), 'nope')
  t.absent(openAgeStore(missing).verified(m))
  t.absent(fs.existsSync(missing))
})

test('fail() refuses later calls', async (t) => {
  const { store } = setup(t)
  store.fail()
  t.absent(store.available())
  await rejects(t, store.record({ member: memberKey(), band: '18+', method: 'didit' }), 'indisponivel', 'after fail')
})

test('reopen reads the band back', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  await store.record({ member: m, band: '16-17', method: 'didit' })
  const again = open()
  t.ok(again.verified(m))
  t.alike(again.get(m), { band: '16-17', method: 'didit', checkedAt: iso(T0) })
})

test('a failed write rejects and the member stays unverified', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  stubRename(t, () => {
    throw Object.assign(new Error('simulado'), { code: 'EIO' })
  })
  await rejects(t, store.record({ member: m, band: '18+', method: 'didit' }), 'indisponivel', 'write failed')
  t.absent(store.verified(m), 'not verified in memory')
  t.is(store.get(m), null)
  t.ok(store.available())
  t.absent(fs.existsSync(file))
})

test('a write that lands but then throws is adopted only after a re-read', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  let renames = 0
  let failNext = true
  const restore = stubRename(t, (rename, from, to) => {
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
  await rejects(t, store.record({ member: m, band: '18+', method: 'didit' }), 'indisponivel', 'fsync failed')
  t.absent(store.verified(m), 'unacknowledged write is not readable')
  const repeat = await store.record({ member: m, band: '18+', method: 'didit' })
  t.is(repeat.changed, false, 'the re-read found the landed entry')
  t.is(renames, 2, 'dirty: rewritten before answering')
  t.ok(store.verified(m))
  restore()
})

test('a failed write whose file cannot be reloaded marks the store unavailable', async (t) => {
  const { store, file } = setup(t)
  await store.record({ member: memberKey(), band: '18+', method: 'didit' })
  stubRename(t, (rename, from, to) => {
    if (to === file) {
      fs.unlinkSync(from)
      fs.writeFileSync(file, 'garbage')
      throw Object.assign(new Error('simulado'), { code: 'EIO' })
    }
    return rename.call(fs, from, to)
  })
  await rejects(t, store.record({ member: memberKey(), band: '18+', method: 'didit' }), 'indisponivel', 'write failed')
  t.absent(store.available())
})

test('heal() writes back a record an external replacement dropped', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.record({ member: m, band: '18+', method: 'didit' })
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: {} }))
  t.is(await store.heal(), true)
  t.ok(readFile(file).members[m])
  t.is(await store.heal(), false, 'nothing left to do')
})

test('heal() adopts a record only the disk had without writing', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  await open().record({ member: m, band: '16-17', method: 'didit' })
  t.absent(store.verified(m))
  t.is(await store.heal(), false)
  t.ok(store.verified(m))
})

test('heal() never throws when the write fails and heals on the next call', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.record({ member: m, band: '18+', method: 'didit' })
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: {} }))
  const restore = stubRename(t, () => {
    throw Object.assign(new Error('simulado'), { code: 'EIO' })
  })
  t.is(await store.heal(), false)
  restore()
  t.is(await store.heal(), true)
  t.ok(readFile(file).members[m])
})

test('heal() writes nothing when the guard refuses or after fail()', async (t) => {
  let allow = true
  const { store, file } = setup(t, { guard: () => allow })
  const m = memberKey()
  await store.record({ member: m, band: '18+', method: 'didit' })
  fs.writeFileSync(file, JSON.stringify({ v: 1, members: {} }))
  allow = false
  t.is(await store.heal(), false)
  allow = true
  store.fail()
  t.is(await store.heal(), false)
  t.alike(readFile(file), { v: 1, members: {} })
})

test('heal() satisfies the startHeal contract: resolves a boolean, never rejects', async (t) => {
  const { store } = setup(t)
  const p = store.heal()
  t.ok(p instanceof Promise)
  t.is(typeof await p, 'boolean')
  store.fail()
  t.is(await store.heal(), false)
})

test('concurrent records serialize', async (t) => {
  const { store, file } = setup(t)
  const ms = [memberKey(), memberKey(), memberKey()]
  const outs = await Promise.all(ms.map((member) => store.record({ member, band: '18+', method: 'didit' })))
  t.alike(outs.map((o) => o.changed), [true, true, true])
  t.is(Object.keys(readFile(file).members).length, 3)
})
