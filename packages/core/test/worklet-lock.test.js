'use strict'

// openStore({ lock: 'worklet' | 'posix', recover, suspend }) on Node.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const store = require('../lib/store')
const { tmpDir } = require('./helpers/tmp')

const OWNER_RE = /^[1-9][0-9]{0,9} [0-9a-f]{32}\n$/

async function open (t, dir, opts) {
  const s = await store.openStore(dir, opts)
  let closed = false
  const close = async () => { if (!closed) { closed = true; await s.close() } }
  t.teardown(close, { force: true })
  s.closeOnce = close
  return s
}

// process.kill is recorded (and, in posix mode, delegated): the worklet mode
// must never call it.
function spyKill (t) {
  const calls = []
  const original = process.kill
  process.kill = function (pid, signal) {
    calls.push([pid, signal])
    return original.call(process, pid, signal)
  }
  t.teardown(() => { process.kill = original })
  return calls
}

function plantForeignLock (dir, pid = 4242) {
  const lockDir = path.join(dir, '.varanda-lock')
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(lockDir, 'pid'), pid + ' ' + 'ab'.repeat(16) + '\n', { mode: 0o600 })
  return lockDir
}

async function codeOf (p) {
  try {
    await p
    return null
  } catch (err) {
    return err.code || err.message
  }
}

test('worklet: held by this process -> LOCKED, never probes a pid', async (t) => {
  const kills = spyKill(t)
  const dir = tmpDir(t)
  const s = await open(t, dir, { lock: 'worklet' })
  const lockDir = path.join(dir, '.varanda-lock')
  t.ok(fs.lstatSync(lockDir).isDirectory())
  const owner = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
  t.ok(OWNER_RE.test(owner), 'owner file is <pid> <token>\\n')
  t.is(Number(owner.split(' ')[0]), process.pid)
  let err = null
  try { await store.openStore(dir, { lock: 'worklet' }) } catch (e) { err = e }
  t.is(err && err.code, 'LOCKED')
  t.is(err.message, 'diretório de dados em uso')
  err = null
  try { await store.openStore(dir, { lock: 'worklet', recover: true }) } catch (e) { err = e }
  t.is(err && err.code, 'LOCKED', 'recover never takes over a lock held by this process')
  t.is(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), owner, 'the held lock is untouched')
  await s.closeOnce()
  t.absent(fs.existsSync(lockDir), 'released on close')
  const s2 = await open(t, dir, { lock: 'worklet' })
  await s2.closeOnce()
  t.alike(kills, [], 'process.kill never called')
})

test('worklet: recover never takes over our own lock through a path alias', async (t) => {
  const dir = tmpDir(t)
  const s = await open(t, dir, { lock: 'worklet' })
  const lockDir = path.join(dir, '.varanda-lock')
  const owner = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
  const alias = dir + '-alias'
  fs.symlinkSync(dir, alias)
  t.teardown(() => { try { fs.unlinkSync(alias) } catch {} })
  t.is(await codeOf(store.openStore(alias, { lock: 'worklet', recover: true })), 'LOCKED', 'symlink alias')
  t.is(await codeOf(store.openStore(path.relative(process.cwd(), dir), { lock: 'worklet', recover: true })), 'LOCKED', 'relative path')
  t.is(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), owner, 'the held lock is untouched')
  await s.closeOnce()
})

test('worklet: a foreign lock is LOCKED; recover takes it over', async (t) => {
  const kills = spyKill(t)
  const dir = tmpDir(t)
  fs.mkdirSync(dir, { recursive: true })
  const lockDir = plantForeignLock(dir, process.pid) // even our own pid is no proof
  t.is(await codeOf(store.openStore(dir, { lock: 'worklet' })), 'LOCKED')
  t.is(await codeOf(store.openStore(dir, { lock: 'worklet', recover: false })), 'LOCKED')
  t.ok(fs.existsSync(path.join(lockDir, 'pid')), 'the foreign lock is left alone')
  t.alike(kills, [])
  const s = await open(t, dir, { lock: 'worklet', recover: true })
  const owner = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
  t.ok(OWNER_RE.test(owner))
  t.is(Number(owner.split(' ')[0]), process.pid)
  t.not(owner, process.pid + ' ' + 'ab'.repeat(16) + '\n', 'a fresh token')
  t.absent(fs.existsSync(lockDir + '.takeover'), 'takeover mutex released')
  t.alike(kills, [], 'process.kill never called, even with recover')
  await s.closeOnce()
  t.absent(fs.existsSync(lockDir))
  // A dead, pid-less (young) lock is also recovered at once: no grace wait.
  fs.mkdirSync(lockDir, { mode: 0o700 })
  const started = Date.now()
  const s2 = await open(t, dir, { lock: 'worklet', recover: true })
  t.ok(Date.now() - started < 5000, 'no LOCK_GRACE_MS wait')
  await s2.closeOnce()
  t.alike(kills, [])
})

test('worklet: LOCK_INVALID and STORE_INVALID unchanged', async (t) => {
  const kills = spyKill(t)
  const dir = tmpDir(t)
  fs.mkdirSync(dir, { recursive: true })
  const lockDir = path.join(dir, '.varanda-lock')
  fs.writeFileSync(lockDir, 'not a dir')
  for (const opts of [{ lock: 'worklet' }, { lock: 'worklet', recover: true }]) {
    let err = null
    try { await store.openStore(dir, opts) } catch (e) { err = e }
    t.is(err && err.code, 'LOCK_INVALID')
    t.is(err.message, 'lock inválido (não é um diretório): ' + lockDir)
  }
  fs.unlinkSync(lockDir)
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'store'))
  t.is(await codeOf(store.openStore(dir, { lock: 'worklet', recover: true })), 'STORE_INVALID')
  t.absent(fs.existsSync(lockDir), 'the lock taken for the failed open was released')
  t.alike(kills, [])
})

test('invalid lock value is refused before touching the disk', async (t) => {
  const dir = path.join(tmpDir(t), 'never-created')
  for (const lock of ['xyz', '', null, 0, true]) {
    let err = null
    try { await store.openStore(dir, { lock }) } catch (e) { err = e }
    t.ok(err instanceof Error)
    t.is(err.message, 'lock inválido')
    t.is(err.code, undefined)
  }
  t.absent(fs.existsSync(dir), 'the data dir was never created')
})

test('posix (default): held -> LOCKED, dead pid taken over, kill probed', async (t) => {
  const kills = spyKill(t)
  const dir = tmpDir(t)
  for (const opts of [undefined, {}, { lock: 'posix' }]) {
    const s = await open(t, dir, opts)
    t.is(await codeOf(store.openStore(dir, opts)), 'LOCKED')
    t.is(await codeOf(store.openStore(dir, { lock: 'worklet' })), 'LOCKED', 'a worklet opener sees the posix lock')
    await s.closeOnce()
  }
  // Our own pid is live only with a token this process holds: decided by
  // the token, without a probe.
  t.alike(kills, [], 'a lock this process holds needs no probe')
  // A dead pid is stale at once in posix mode.
  let dead = 2 ** 22 - 1
  while (await codeOf(Promise.resolve().then(() => process.kill(dead, 0))) === null) dead--
  kills.length = 0
  plantForeignLock(dir, dead)
  const s = await open(t, dir)
  t.alike(kills, [[dead, 0]])
  const owner = fs.readFileSync(path.join(dir, '.varanda-lock', 'pid'), 'utf8')
  t.is(Number(owner.split(' ')[0]), process.pid)
  await s.closeOnce()
  // recover is a worklet-only option: posix ignores it and still probes.
  kills.length = 0
  plantForeignLock(dir, process.ppid)
  t.is(await codeOf(store.openStore(dir, { lock: 'posix', recover: true })), 'LOCKED')
  t.alike(kills, [[process.ppid, 0]], 'a foreign live pid is probed')
  fs.rmSync(path.join(dir, '.varanda-lock'), { recursive: true, force: true })
  // Our own pid with a token this process does not hold was written by a
  // dead process with the same pid (a restarted container): stale at once.
  kills.length = 0
  plantForeignLock(dir, process.pid)
  const again = await open(t, dir)
  t.alike(kills, [], 'no probe for our own pid')
  t.is(Number(fs.readFileSync(path.join(dir, '.varanda-lock', 'pid'), 'utf8').split(' ')[0]), process.pid)
  await again.closeOnce()
})

test('suspend reaches Corestore in openStore and openQuarantine', async (t) => {
  const dir = tmpDir(t)
  // corestore 7: shouldSuspend = isAndroid ? !!opts.suspend : opts.suspend !== false
  const byDefault = await open(t, dir)
  t.is(byDefault.shouldSuspend, true, 'default construction')
  await byDefault.closeOnce()
  const off = await open(t, dir, { lock: 'worklet', suspend: false })
  t.is(off.shouldSuspend, false)
  await off.closeOnce()
  const on = await open(t, dir, { suspend: true })
  t.is(on.shouldSuspend, true)
  await on.closeOnce()
  const q1 = await store.openQuarantine(dir)
  t.is(q1.shouldSuspend, true)
  await q1.close()
  const q2 = await store.openQuarantine(dir, { suspend: false, lock: 'worklet' })
  t.is(q2.shouldSuspend, false)
  await q2.close()
  const q3 = await store.openQuarantine(dir, { suspend: true })
  t.is(q3.shouldSuspend, true)
  await q3.close()
  store.removeQuarantine(dir)
})

test('worklet: the diary works and the lock content is identical to posix', async (t) => {
  const dir = tmpDir(t)
  const s = await open(t, dir, { lock: 'worklet' })
  const diary = await store.openDiary(s)
  t.ok(diary.writable)
  const key = b4a.toString(diary.key, 'hex')
  t.is(key.length, 64)
  await s.closeOnce()
  const s2 = await open(t, dir)
  const d2 = await store.openDiary(s2)
  t.is(b4a.toString(d2.key, 'hex'), key, 'the same store opens in posix mode')
  await s2.closeOnce()
})

// A dev reload leaves the previous JS context's worklet alive while the new
// one starts with recover: true. Each context has its own copy of lib/store.js
// (its own held-lock set), here a fresh module instance in the same process,
// as two worklets share the app's process. The lock directory cannot tell them
// apart, so the takeover goes through; RocksDB's per-process file lock is what
// refuses the second open.
test('worklet: a second context taking over a live context lock is refused by RocksDB', async (t) => {
  const dir = tmpDir(t)
  const first = await open(t, dir, { lock: 'worklet' })
  const core = first.get({ name: 'diary' })
  await core.ready()
  await core.append(b4a.from('antes do reload'))

  const path2 = require.resolve('../lib/store')
  const saved = require.cache[path2]
  delete require.cache[path2]
  const second = require('../lib/store')
  t.teardown(() => { require.cache[path2] = saved })
  t.not(second, store, 'a fresh module instance has its own held set')

  let err = null
  try { await second.openStore(dir, { lock: 'worklet', recover: true }) } catch (e) { err = e }
  t.ok(err, 'the second open fails')
  t.ok(/could not be locked/.test(err && err.message), 'RocksDB refuses the lock')

  t.is((await core.get(0)).toString(), 'antes do reload', 'the live store keeps its data')
  await core.append(b4a.from('depois'))
  t.is(core.length, 2, 'and keeps working')
  await first.closeOnce()
  const third = await open(t, dir, { lock: 'worklet' })
  const again = third.get({ name: 'diary' })
  await again.ready()
  t.is(again.length, 2, 'nothing was lost or corrupted')
  await third.closeOnce()
})
