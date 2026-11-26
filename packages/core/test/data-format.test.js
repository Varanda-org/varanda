'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const store = require('../lib/store')
const { ensureDataFormat, FORMAT_FILE } = require('../lib/data-format')
const { memberCertRecord, profileRecord, postRecord } = require('../lib/records')
const { tmpDir } = require('./helpers/tmp')

const AT = '2026-01-01T00:00:00.000Z'

async function buildMemberDir (t) {
  const dir = tmpDir(t)
  const s = await store.openStore(dir)
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord({
    v: 1, member: hex, ageBand: '18+', method: 'stub', date: AT, association: 'c'.repeat(64), signature: 'd'.repeat(128)
  }))
  await store.appendRecord(diary, profileRecord({ name: 'Ana', at: AT }))
  for (const text of ['um', 'dois', 'tres']) await store.appendRecord(diary, postRecord({ text, at: AT }))
  await s.close()
  store.writeFollows(dir, [hex])
  return dir
}

async function snapshot (dir) {
  const s = await store.openStore(dir)
  try {
    const diary = await store.openDiary(s)
    const raw = await store.readRaw(diary)
    return { key: b4a.toString(diary.key, 'hex'), length: diary.length, raw: JSON.stringify(raw) }
  } finally {
    await s.close()
  }
}

async function codeOf (fn) {
  try {
    await fn()
  } catch (err) {
    return err.code
  }
  return null
}

const readFormat = (dir) => JSON.parse(fs.readFileSync(path.join(dir, FORMAT_FILE), 'utf8'))
const formatExists = (dir) => fs.existsSync(path.join(dir, FORMAT_FILE))

// Two writes then a marker, so a crash can land between them.
function twoWrites (state, failAt) {
  return {
    2: {
      async run (ctx) {
        state.calls++
        if (failAt === 'immediate') throw new Error('boom')
        ctx.writeJsonAtomic('step-a.json', { a: 1 })
        if (failAt === 'mid') throw new Error('boom')
        ctx.writeJsonAtomic('step-b.json', { b: 2 })
        if (failAt === 'late') throw new Error('boom')
        ctx.remove('follows.old')
      }
    }
  }
}

test('openStore writes no format.json for a fresh or an existing dir', async (t) => {
  const dir = tmpDir(t)
  const s = await store.openStore(dir)
  await s.close()
  t.absent(formatExists(dir))
  const s2 = await store.openStore(dir)
  await s2.close()
  t.absent(formatExists(dir))
})

const outputs = []

for (const failAt of ['immediate', 'mid', 'late']) {
  test('crash resume: ' + failAt, async (t) => {
    const dir = await buildMemberDir(t)
    const before = await snapshot(dir)
    const state = { calls: 0 }
    await t.exception(() => store.openStore(dir, { dataFormat: { target: 2, migrations: twoWrites(state, failAt) } }), /boom/)
    t.alike(readFormat(dir), { v: 1, format: 1, migrating: 2 })

    // the lock was released
    const resumed = await store.openStore(dir, { dataFormat: { target: 2, migrations: twoWrites(state, null) } })
    await resumed.close()
    t.alike(readFormat(dir), { v: 1, format: 2, migrating: null })
    t.is(state.calls, 2)
    t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'step-a.json'), 'utf8')), { a: 1 })
    t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'step-b.json'), 'utf8')), { b: 2 })
    t.alike(await snapshotAt(dir, 2), before)
    outputs.push(['step-a.json', 'step-b.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('|'))
    if (outputs.length > 1) t.is(outputs[outputs.length - 1], outputs[0])

    // third open: nothing to run
    const again = await store.openStore(dir, { dataFormat: { target: 2, migrations: twoWrites(state, null) } })
    await again.close()
    t.is(state.calls, 2)
  })
}

function snapshotAt (dir, target) {
  return snapshotWith(dir, { target, migrations: { 2: { run () { throw new Error('must not run') } } } })
}

async function snapshotWith (dir, dataFormat) {
  const s = await store.openStore(dir, { dataFormat })
  try {
    const diary = await store.openDiary(s)
    const raw = await store.readRaw(diary)
    return { key: b4a.toString(diary.key, 'hex'), length: diary.length, raw: JSON.stringify(raw) }
  } finally {
    await s.close()
  }
}

test('an older build refuses a newer or half-migrated dir, untouched', async (t) => {
  const dir = await buildMemberDir(t)
  const state = { calls: 0 }
  const s = await store.openStore(dir, { dataFormat: { target: 2, migrations: twoWrites(state, null) } })
  await s.close()
  const storeDir = path.join(dir, 'store')
  const listing = () => JSON.stringify(fs.readdirSync(storeDir).sort())
  const before = listing()

  for (let i = 0; i < 2; i++) {
    t.is(await codeOf(() => store.openStore(dir)), 'DATA_FORMAT_NEWER')
  }
  t.is(listing(), before)

  fs.writeFileSync(path.join(dir, FORMAT_FILE), JSON.stringify({ v: 1, format: 1, migrating: 2 }))
  for (let i = 0; i < 2; i++) {
    t.is(await codeOf(() => store.openStore(dir)), 'DATA_FORMAT_NEWER')
  }
  t.is(listing(), before)
  t.alike(readFormat(dir), { v: 1, format: 1, migrating: 2 })
})

test('step context refuses names outside the data dir files', async (t) => {
  const dir = tmpDir(t)
  const names = ['store/x', '../x', 'format.json', 'Format.json', 'STORE', 'seeder-key.json', 'Noise-Key.json', 'dm-seed.json', 'passkeys.json', 'recovery.json', 'issuer-cert.json', '.varanda-lock', 'quarantine', 'store', '', '.x', 'a\\b', 'a/b', 5]
  const seen = []
  const migrations = {
    2: {
      async run (ctx) {
        for (const name of names) {
          for (const fn of [
            () => ctx.readJson(name, null),
            () => ctx.writeJsonAtomic(name, {}),
            () => ctx.exists(name),
            () => ctx.remove(name)
          ]) {
            try { fn(); seen.push('ok') } catch (err) { seen.push(err.code) }
          }
        }
        t.ok(!ctx.exists('fine.json'))
        ctx.writeJsonAtomic('fine.json', { ok: 1 })
        t.alike(ctx.readJson('fine.json', null), { ok: 1 })
        ctx.remove('fine.json')
        t.ok(!ctx.exists('fine.json'))
        fs.symlinkSync(path.join(dir, 'format.json'), path.join(dir, 'link.json'))
        fs.mkdirSync(path.join(dir, 'sub'))
        for (const name of ['link.json', 'sub']) {
          try { ctx.readJson(name, null); seen.push('ok') } catch (err) { seen.push(err.code) }
        }
      }
    }
  }
  await ensureDataFormat(dir, { target: 2, migrations })
  t.ok(seen.every((c) => c === 'DATA_FORMAT_NAME'))
  t.is(seen.length, names.length * 4 + 2)
})

test('a missing step is refused before anything is written', async (t) => {
  const dir = tmpDir(t)
  t.is(await codeOf(() => ensureDataFormat(dir, { target: 2, migrations: {} })), 'DATA_FORMAT_MISSING_STEP')
  t.absent(formatExists(dir))
})

test('torn, off-shape or symlinked format.json is invalid', async (t) => {
  const bad = [
    '{"v":1,"format":1',
    '[]',
    'null',
    JSON.stringify({ v: 1, format: 1 }),
    JSON.stringify({ v: 1, format: 0, migrating: null }),
    JSON.stringify({ v: 2, format: 1, migrating: null }),
    JSON.stringify({ v: 1, format: 1.5, migrating: null }),
    JSON.stringify({ v: 1, format: 1, migrating: 'x' }),
    JSON.stringify({ v: 1, format: 1, migrating: null, extra: 1 })
  ]
  for (const content of bad) {
    const dir = tmpDir(t)
    fs.writeFileSync(path.join(dir, FORMAT_FILE), content)
    t.is(await codeOf(() => ensureDataFormat(dir)), 'DATA_FORMAT_INVALID')
  }
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify({ v: 1, format: 1, migrating: null }))
  fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, FORMAT_FILE))
  t.is(await codeOf(() => ensureDataFormat(dir)), 'DATA_FORMAT_INVALID')
  const dir2 = tmpDir(t)
  fs.mkdirSync(path.join(dir2, FORMAT_FILE))
  t.is(await codeOf(() => ensureDataFormat(dir2)), 'DATA_FORMAT_INVALID')
})
