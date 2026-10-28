'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const test = require('brittle')
const b4a = require('b4a')
const store = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord } = require('../lib/records')
const { testnet } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')

const AT = '2026-01-01T00:00:00.000Z'
const certFixture = (member) => ({
  v: 1,
  member,
  ageBand: '18+',
  method: 'stub',
  date: AT,
  association: 'c'.repeat(64),
  signature: 'd'.repeat(128)
})

async function open (t, dir) {
  const s = await store.openStore(dir)
  let closed = false
  const close = async () => { if (!closed) { closed = true; await s.close() } }
  t.teardown(close, { force: true })
  s.closeOnce = close
  return s
}

test('diary key is stable across reopen and writable', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  t.absent(store.storeExists(dir))

  const s1 = await open(t, dir)
  t.ok(store.storeExists(dir))
  const d1 = await store.openDiary(s1)
  t.ok(d1.writable)
  const key = b4a.toString(d1.key, 'hex')
  t.is(d1.fork, 0)
  await s1.closeOnce()

  const s2 = await open(t, dir)
  const d2 = await store.openDiary(s2)
  t.is(b4a.toString(d2.key, 'hex'), key)
  t.ok(d2.writable)
  await s2.closeOnce()
})

test('replica of a diary key is not writable and empty', async (t) => {
  await testnet(t)
  const a = await open(t, tmpDir(t))
  const b = await open(t, tmpDir(t))
  const diary = await store.openDiary(a)
  const hex = b4a.toString(diary.key, 'hex')

  const replica = await store.openReplica(b, hex.toUpperCase())
  t.absent(replica.writable)
  t.is(replica.fork, 0)
  t.is(replica.length, 0)
  t.alike(await store.readAll(replica), [])
  await t.exception(() => store.openReplica(b, 'xyz'), /chave inválida/)
  await t.exception(() => store.openReplica(b, 'a'.repeat(63)), /chave inválida/)
})

test('appendRecord enforces the block-0 certificate rule', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const s1 = await open(t, dir)
  const diary = await store.openDiary(s1)
  const hex = b4a.toString(diary.key, 'hex')

  await t.exception(
    () => store.appendRecord(diary, profileRecord({ name: 'Ana', at: AT })),
    /registro inválido: genesis-required/
  )
  try {
    await store.appendRecord(diary, postRecord({ text: 'oi', at: AT }))
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'INVALID_RECORD')
  }
  t.is(diary.length, 0)

  t.is(await store.appendRecord(diary, memberCertRecord(certFixture(hex))), 0)
  await t.exception(
    () => store.appendRecord(diary, memberCertRecord(certFixture(hex))),
    /cert-not-first/
  )
  t.is(await store.appendRecord(diary, profileRecord({ name: 'Ana', bio: 'oi', at: AT })), 1)
  t.is(await store.appendRecord(diary, postRecord({ text: 'olá', at: AT })), 2)
  t.is(diary.length, 3)
  await s1.closeOnce()

  const s2 = await open(t, dir)
  const again = await store.openDiary(s2)
  const entries = await store.readAll(again)
  t.is(entries.length, 3)
  t.alike(entries.map((e) => e.seq), [0, 1, 2])
  t.is(entries[0].record.type, 'member-cert')
  t.alike(entries[1].record, { type: 'profile', name: 'Ana', bio: 'oi', at: AT })
  t.alike(entries[2].record, { type: 'post', text: 'olá', at: AT, replyTo: null })
})

test('readAll keeps undecodable blocks as null and never throws', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))

  const raw = s.get({ name: 'diary', valueEncoding: 'binary' })
  await raw.ready()
  await raw.append(b4a.from('isto não é json {'))
  await store.appendRecord(diary, postRecord({ text: 'depois', at: AT }))
  await raw.append(b4a.from('[1,2]'))

  const entries = await store.readAll(diary)
  t.is(entries.length, 4)
  t.is(entries[0].record.type, 'member-cert')
  t.is(entries[1].record, null)
  t.is(entries[1].seq, 1)
  t.is(entries[2].record.text, 'depois')
  t.is(entries[2].seq, 2)
  t.is(entries[3].record, null)
})

test('config round-trip', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  t.is(store.readConfig(dir), null)
  const cfg = { v: 1, role: 'member', association: 'a'.repeat(64) }
  store.writeConfig(dir, cfg)
  t.alike(store.readConfig(dir), cfg)
  t.absent(fs.existsSync(path.join(dir, 'config.json.tmp')))
})

test('follows round-trip and dedupe', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  t.alike(store.readFollows(dir), [])
  store.writeFollows(dir, ['B'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)])
  t.alike(store.readFollows(dir), ['a'.repeat(64), 'b'.repeat(64)])
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'follows.json'), 'utf8')), { v: 1, follows: ['a'.repeat(64), 'b'.repeat(64)] })
  t.absent(fs.existsSync(path.join(dir, 'follows.json.tmp')))
  store.writeFollows(dir, [])
  t.alike(store.readFollows(dir), [])
})

test('blocklist round-trip, absent and malformed are null, mode 0600', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const snapshot = { v: 1, seq: 3, blocked: ['a'.repeat(64)] }
  t.is(store.readBlocklist(dir), null, 'absent')
  store.writeBlocklist(dir, snapshot)
  t.alike(store.readBlocklist(dir), { v: 1, snapshot })
  const file = path.join(dir, 'blocklist.json')
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, snapshot })
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  for (const bad of ['not json', '[]', '{"v":2,"snapshot":{}}', '{"v":1}', '{"v":1,"snapshot":[]}', '{"v":1,"snapshot":null}']) {
    fs.writeFileSync(file, bad)
    t.is(store.readBlocklist(dir), null, 'malformed: ' + bad)
  }
})

test('readBlocklist moves a torn file aside only when the caller asks, an absent or odd-shaped one never', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const file = path.join(dir, 'blocklist.json')
  const aside = () => fs.readdirSync(dir).filter((n) => n.startsWith('blocklist.json.ilegivel-'))
  const seen = []
  const onUnreadable = (name) => seen.push(name)

  t.is(store.readBlocklist(dir, { onUnreadable }), null, 'absent')
  t.alike(seen, [], 'absent: no warning')
  fs.writeFileSync(file, '[]')
  t.is(store.readBlocklist(dir, { onUnreadable }), null, 'odd shape')
  t.alike(seen, [], 'odd shape: no warning')
  t.ok(fs.existsSync(file), 'odd shape: left in place')

  fs.writeFileSync(file, '{"v":1,"snapshot":{"seq":')
  fs.chmodSync(file, 0o600)
  t.is(store.readBlocklist(dir), null, 'torn, no callback: read as absent')
  t.ok(fs.existsSync(file), 'torn, no callback: left in place (read-only callers)')

  t.is(store.readBlocklist(dir, { onUnreadable }), null, 'torn: read as absent')
  t.is(seen.length, 1, 'torn: one warning')
  t.absent(fs.existsSync(file), 'torn: moved out of the way')
  t.alike(aside(), seen, 'torn: the warning names the kept copy')
  t.is(fs.readFileSync(path.join(dir, seen[0]), 'utf8'), '{"v":1,"snapshot":{"seq":', 'torn: bytes kept')
  t.is(fs.statSync(path.join(dir, seen[0])).mode & 0o777, 0o600, 'torn: mode kept')

  t.is(store.readBlocklist(dir, { onUnreadable }), null, 'after the move it is a plain absent')
  t.is(seen.length, 1, 'no second warning')
})

test('replicaStored is true only for a core the store holds', async (t) => {
  await testnet(t)
  const a = await open(t, tmpDir(t))
  const b = await open(t, tmpDir(t))
  const diary = await store.openDiary(a)
  const hex = b4a.toString(diary.key, 'hex')
  t.ok(await store.replicaStored(a, hex), 'own diary')
  t.absent(await store.replicaStored(b, hex), 'not stored')
  await store.openReplica(b, hex)
  t.ok(await store.replicaStored(b, hex.toUpperCase()), 'replica opened')
  t.absent(await store.replicaStored(b, 'e'.repeat(64)), 'unknown key')
})

test('writeJsonAtomic and readJson', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const file = path.join(dir, 'sub', 'deep', 'x.json')
  t.alike(store.readJson(file, { d: 1 }), { d: 1 })
  store.writeJsonAtomic(file, { a: 1 })
  t.alike(store.readJson(file, null), { a: 1 })
  t.alike(fs.readdirSync(path.dirname(file)), ['x.json'])
  const secret = path.join(dir, 'secret.json')
  store.writeJsonAtomic(secret, { k: 1 }, 0o600)
  t.is(fs.statSync(secret).mode & 0o777, 0o600)
  t.absent(fs.existsSync(secret + '.tmp'))
})

test('writeJsonAtomic never follows a planted symlink at <file>.tmp', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const outside = tmpDir(t)
  const target = path.join(outside, 'stolen')
  const planted = path.join(dir, 'follows.json.tmp')
  fs.symlinkSync(target, planted)
  store.writeFollows(dir, ['a'.repeat(64)])
  t.alike(store.readFollows(dir), ['a'.repeat(64)])
  t.absent(fs.existsSync(target), 'symlink target never created')
  t.ok(fs.lstatSync(planted).isSymbolicLink(), 'planted link untouched')
  t.ok(fs.lstatSync(path.join(dir, 'follows.json')).isFile())
  t.alike(fs.readdirSync(dir).sort(), ['follows.json', 'follows.json.tmp'], 'no temp file left')
})

test('writeJsonAtomic: concurrent writers both succeed and one wins', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const file = path.join(dir, 'config.json')
  const script = 'const s = require(' + JSON.stringify(require.resolve('../lib/store')) + ');' +
    'for (let i = 0; i < 200; i++) s.writeJsonAtomic(process.argv[1], { writer: process.argv[2], i })'
  const run = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, file, name], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
  const results = await Promise.all([run('um'), run('dois')])
  for (const r of results) t.is(r.code, 0, r.stderr)
  const last = store.readJson(file, null)
  t.ok(last && (last.writer === 'um' || last.writer === 'dois') && last.i === 199, JSON.stringify(last))
  t.alike(fs.readdirSync(dir), ['config.json'], 'no temp files left')
})

test('openQuarantine wipes leftovers and is distinct from the main store', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const junk = path.join(dir, 'quarantine', 'junk')
  fs.mkdirSync(path.dirname(junk), { recursive: true })
  fs.writeFileSync(junk, 'x')

  const main = await open(t, dir)
  const q = await store.openQuarantine(dir)
  t.teardown(() => q.close(), { force: true })
  t.absent(fs.existsSync(junk))
  t.ok(fs.existsSync(path.join(dir, 'quarantine')))
  t.not(q, main)

  const mainCore = await store.openDiary(main)
  const qCore = q.get({ name: 'diary' })
  await qCore.ready()
  t.not(b4a.toString(qCore.key, 'hex'), b4a.toString(mainCore.key, 'hex'))

  await q.close()
  store.removeQuarantine(dir)
  t.absent(fs.existsSync(path.join(dir, 'quarantine')))
  store.removeQuarantine(dir) // best effort, no throw when missing
})

test('purgeReplica empties a replica', async (t) => {
  await testnet(t)
  const a = await open(t, tmpDir(t))
  const b = await open(t, tmpDir(t))
  const diary = await store.openDiary(a)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))

  // replicate a -> b locally so the replica has block 0
  const replica = await store.openReplica(b, hex)
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() }, { force: true })
  t.ok(await replica.get(0, { raw: true, timeout: 10000 }))
  t.is(replica.fork, 0)
  t.is(replica.contiguousLength, 1)
  s1.destroy()
  s2.destroy()

  await store.purgeReplica(b, hex)
  const again = await store.openReplica(b, hex)
  t.is(again.length, 0)
  t.is(again.contiguousLength, 0)
  t.is(again.fork, 0)
  t.absent(again.writable)
})

test('openStore makes the data dir and store dir private', async (t) => {
  await testnet(t)
  const fresh = path.join(tmpDir(t), 'nova')
  const s1 = await open(t, fresh)
  t.is(fs.statSync(fresh).mode & 0o077, 0)
  t.is(fs.statSync(path.join(fresh, 'store')).mode & 0o077, 0)
  await s1.closeOnce()

  // existing dirs with loose modes are tightened
  const loose = tmpDir(t)
  fs.mkdirSync(path.join(loose, 'store'), { recursive: true })
  fs.chmodSync(loose, 0o755)
  fs.chmodSync(path.join(loose, 'store'), 0o755)
  const s2 = await open(t, loose)
  t.is(fs.statSync(loose).mode & 0o077, 0)
  t.is(fs.statSync(path.join(loose, 'store')).mode & 0o077, 0)
  await s2.closeOnce()
})

test('concurrent appendRecord: one genesis wins, the other is cert-not-first', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  const results = await Promise.allSettled([
    store.appendRecord(diary, memberCertRecord(certFixture(hex))),
    store.appendRecord(diary, memberCertRecord(certFixture(hex)))
  ])
  const ok = results.filter((r) => r.status === 'fulfilled')
  const bad = results.filter((r) => r.status === 'rejected')
  t.is(ok.length, 1)
  t.is(ok[0].value, 0)
  t.is(bad.length, 1)
  t.is(bad[0].reason.code, 'INVALID_RECORD')
  t.ok(/cert-not-first/.test(bad[0].reason.message))
  t.is(diary.length, 1)
})

test('appendRecord validates the serialized value', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))

  // toJSON turns a valid-looking post into an empty one: rejected
  const sneaky = { ...postRecord({ text: 'oi', at: AT }), toJSON () { return { type: 'post', text: '', at: AT, replyTo: null } } }
  await t.exception(() => store.appendRecord(diary, sneaky), /text-length/)

  // accessor that changes on the second read: the stored block is exactly
  // the value that was validated
  let reads = 0
  const shifty = {
    type: 'post',
    get text () { return reads++ === 0 ? 'ok' : 'x'.repeat(5000) },
    at: AT,
    replyTo: null
  }
  t.is(await store.appendRecord(diary, shifty), 1)
  const entries = await store.readAll(diary)
  t.alike(entries[1].record, { type: 'post', text: 'ok', at: AT, replyTo: null })

  // unserializable input is malformed
  await t.exception(() => store.appendRecord(diary, undefined), /malformed/)
  t.is(diary.length, 2)
})

test('appendRecord waits for ready before computing the seq', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const s1 = await open(t, dir)
  const diary = await store.openDiary(s1)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))
  await s1.closeOnce()

  const s2 = await open(t, dir)
  const notReady = s2.get({ name: 'diary', valueEncoding: 'json' })
  t.is(await store.appendRecord(notReady, postRecord({ text: 'oi', at: AT })), 1)
  await t.exception(() => store.appendRecord(notReady, memberCertRecord(certFixture(hex))), /cert-not-first/)
  t.is(notReady.length, 2)
})

test('readAll on a closed core rejects', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))
  await diary.close()
  await t.exception(() => store.readAll(diary), /SESSION_CLOSED/)
})

test('openReplica of the own diary key is never writable', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))

  const replica = await store.openReplica(s, hex)
  t.absent(replica.writable)
  t.is(replica.fork, 0)
  await t.exception(() => store.appendRecord(replica, postRecord({ text: 'oi', at: AT })))
  t.is(diary.length, 1)
  t.ok(diary.writable)
})

test('two sessions of the same diary append through one queue', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const d1 = await store.openDiary(s)
  const d2 = await store.openDiary(s)
  t.not(d1, d2)
  const hex = b4a.toString(d1.key, 'hex')
  const results = await Promise.allSettled([
    store.appendRecord(d1, memberCertRecord(certFixture(hex))),
    store.appendRecord(d2, memberCertRecord(certFixture(hex)))
  ])
  t.is(results.filter((r) => r.status === 'fulfilled').length, 1)
  const bad = results.filter((r) => r.status === 'rejected')
  t.is(bad.length, 1)
  t.ok(/cert-not-first/.test(bad[0].reason.message))
  t.is(d1.length, 1)
  t.is(d2.length, 1)
})

function lockDir (dir) {
  return path.join(dir, '.varanda-lock')
}

function plantLock (dir, pidText) {
  fs.mkdirSync(lockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(lockDir(dir), 'pid'), pidText)
}

function deadPid () {
  const r = spawnSync(process.execPath, ['-e', ''])
  return r.pid
}

// The owner file is `<pid> <32 hex token>`.
function ownerPid (dir) {
  const m = /^([0-9]+) [0-9a-f]{32}\n$/.exec(fs.readFileSync(path.join(lockDir(dir), 'pid'), 'utf8'))
  return m ? Number(m[1]) : null
}

// Ages a planted lock dir past the grace period (its own mtime).
function age (p) {
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(p, past, past)
}

function leftovers (dir) {
  return fs.readdirSync(dir).filter((f) => f.startsWith('.varanda-lock.'))
}

test('data-dir lock: a held dir is LOCKED, close releases it', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const s1 = await open(t, dir)
  t.is(ownerPid(dir), process.pid)
  try {
    await store.openStore(dir)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'LOCKED')
    t.is(err.message, 'diretório de dados em uso')
  }
  await s1.closeOnce()
  t.absent(fs.existsSync(lockDir(dir)), 'close removes the lock')
  const s2 = await open(t, dir)
  t.ok(fs.existsSync(lockDir(dir)))
  await s2.closeOnce()

  // a live owner (here: the parent process) on a fresh dir: LOCKED, store untouched
  const fresh = tmpDir(t)
  plantLock(fresh, String(process.ppid) + '\n')
  await t.exception(() => store.openStore(fresh), /diretório de dados em uso/)
  t.absent(fs.existsSync(path.join(fresh, 'store')), 'store dir never created')
  t.ok(fs.existsSync(lockDir(fresh)), 'a live lock is never removed')
})

test('data-dir lock: a stale lock (dead pid, or old garbage) is taken over', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const dead = deadPid()
  plantLock(dir, String(dead) + '\n') // a dead owner is stale whatever its age
  const s1 = await open(t, dir)
  t.is(ownerPid(dir), process.pid)
  t.alike(leftovers(dir), [], 'no stale copy left')
  await s1.closeOnce()

  const garbage = tmpDir(t)
  plantLock(garbage, 'não é um pid')
  age(lockDir(garbage))
  const s2 = await open(t, garbage)
  t.is(ownerPid(garbage), process.pid)
  await s2.closeOnce()

  const empty = tmpDir(t)
  fs.mkdirSync(lockDir(empty))
  age(lockDir(empty))
  const s3 = await open(t, empty)
  t.is(ownerPid(empty), process.pid)
  t.alike(leftovers(empty), [])
  await s3.closeOnce()
})

test('data-dir lock: our own pid with a token we do not hold is stale (restarted container)', async (t) => {
  await testnet(t)
  // A container restarts its process with the same pid (1): the lock the
  // killed run left carries our pid but not one of our tokens.
  for (const owner of [process.pid + ' ' + 'e'.repeat(32) + '\n', String(process.pid) + '\n']) {
    const dir = tmpDir(t)
    plantLock(dir, owner)
    t.ok(store.lockHeld(dir) === false, 'probe: not held')
    const s = await open(t, dir)
    t.is(ownerPid(dir), process.pid)
    t.alike(leftovers(dir), [], 'no stale copy left')
    // ...while a lock this process does hold stays LOCKED for a second opener
    t.ok(store.lockHeld(dir), 'probe: held by this process')
    await t.exception(() => store.openStore(dir), /diretório de dados em uso/)
    await s.closeOnce()
  }
})

test('data-dir lock: lockHeld probes without creating, taking over or removing', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  t.is(store.lockHeld(dir), false, 'no lock')
  t.is(store.lockHeld(path.join(dir, 'missing')), false, 'no data dir')
  t.alike(fs.readdirSync(dir), [], 'nothing created')

  plantLock(dir, String(process.ppid) + '\n')
  t.is(store.lockHeld(dir), true, 'live owner')
  plantLock(dir, String(deadPid()) + '\n')
  t.is(store.lockHeld(dir), false, 'dead owner')
  t.ok(fs.existsSync(lockDir(dir)), 'a stale lock is left in place')

  const empty = tmpDir(t)
  fs.mkdirSync(lockDir(empty))
  t.is(store.lockHeld(empty), true, 'a young owner-less lock counts as held')
  age(lockDir(empty))
  t.is(store.lockHeld(empty), false, 'an old owner-less lock is stale')

  const file = tmpDir(t)
  fs.writeFileSync(lockDir(file), 'x')
  t.exception(() => store.lockHeld(file), /lock inválido/)
})

test('data-dir lock: lockDataDir takes the same lock as openStore', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const release = await store.lockDataDir(dir)
  t.is(ownerPid(dir), process.pid)
  t.is(store.lockHeld(dir), true, 'probe: held')
  await t.exception(() => store.lockDataDir(dir), /diretório de dados em uso/)
  try {
    await store.lockDataDir(dir)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'LOCKED')
  }
  await t.exception(() => store.openStore(dir), /diretório de dados em uso/)
  t.absent(fs.existsSync(path.join(dir, 'store')), 'no store dir created')
  release()
  t.is(store.lockHeld(dir), false, 'probe: released')
  t.absent(fs.existsSync(lockDir(dir)))

  const again = await store.lockDataDir(dir)
  release() // a second call of an old release never removes the new lock
  t.is(store.lockHeld(dir), true, 'the later lock survives the stale release')
  again()
  again()
  t.is(store.lockHeld(dir), false)
})

test('data-dir lock: a fresh pid-less lock is not taken over', async (t) => {
  await testnet(t)
  const empty = tmpDir(t)
  fs.mkdirSync(lockDir(empty))
  const started = Date.now()
  await t.exception(() => store.openStore(empty), /diretório de dados em uso/)
  t.ok(Date.now() - started >= 1000, 'still LOCKED after the old 1 s window')
  t.ok(fs.existsSync(lockDir(empty)), 'fresh lock left in place')
  t.absent(fs.existsSync(path.join(empty, 'store')), 'store dir never created')

  const garbage = tmpDir(t)
  plantLock(garbage, 'lixo')
  await t.exception(() => store.openStore(garbage), /diretório de dados em uso/)
  t.is(fs.readFileSync(path.join(lockDir(garbage), 'pid'), 'utf8'), 'lixo', 'untouched')

  // the same locks, once their mtime is past the grace period
  age(lockDir(empty))
  const s = await open(t, empty)
  t.is(ownerPid(empty), process.pid)
  await s.closeOnce()
})

test('data-dir lock: a takeover mutex left by a crash ages out', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  fs.mkdirSync(lockDir(dir))
  age(lockDir(dir))
  const mutex = lockDir(dir) + '.takeover'
  fs.writeFileSync(mutex, 'f'.repeat(32))
  age(mutex)
  const s = await open(t, dir)
  t.is(ownerPid(dir), process.pid)
  t.alike(leftovers(dir), [])
  await s.closeOnce()
})

test('data-dir lock: release never removes a lock whose token is not ours', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const s = await open(t, dir)
  const foreign = process.pid + ' ' + 'e'.repeat(32) + '\n'
  fs.writeFileSync(path.join(lockDir(dir), 'pid'), foreign)
  await s.closeOnce()
  t.is(fs.readFileSync(path.join(lockDir(dir), 'pid'), 'utf8'), foreign, 'foreign lock kept')

  // a lock dir replaced by another one with the same pid but another token
  fs.rmSync(lockDir(dir), { recursive: true })
  const s2 = await open(t, dir)
  fs.rmSync(lockDir(dir), { recursive: true })
  plantLock(dir, foreign)
  await s2.closeOnce()
  t.is(fs.readFileSync(path.join(lockDir(dir), 'pid'), 'utf8'), foreign, 'replacement kept')
})

test('data-dir lock: closing a store again never removes a later opener\'s lock', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const a = await store.openStore(dir)
  t.teardown(() => a.close(), { force: true })
  await a.close()
  const b = await open(t, dir)
  const owner = fs.readFileSync(path.join(lockDir(dir), 'pid'), 'utf8')
  await a.close()
  t.is(fs.readFileSync(path.join(lockDir(dir), 'pid'), 'utf8'), owner, 'b\'s lock intact')
  await t.exception(() => store.openStore(dir), /diretório de dados em uso/)
  await b.closeOnce()
  t.absent(fs.existsSync(lockDir(dir)))
})

test('data-dir lock: a lock path that is not a directory fails at once', async (t) => {
  await testnet(t)
  const cases = {
    'dangling symlink': (p, d) => fs.symlinkSync(path.join(d, 'nowhere'), p),
    'symlink to a dir': (p, d) => fs.symlinkSync(tmpDir(t), p),
    'regular file': (p) => fs.writeFileSync(p, String(process.pid) + '\n')
  }
  for (const [name, plant] of Object.entries(cases)) {
    const dir = tmpDir(t)
    plant(lockDir(dir), dir)
    const started = Date.now()
    try {
      await store.openStore(dir)
      t.fail(name + ': should throw')
    } catch (err) {
      t.is(err.code, 'LOCK_INVALID', name)
      t.ok(/^lock inválido/.test(err.message), name + ': ' + err.message)
    }
    t.ok(Date.now() - started < 500, name + ': fails promptly')
    t.ok(fs.lstatSync(lockDir(dir)), name + ': left in place')
    t.absent(fs.existsSync(path.join(dir, 'store')), name + ': store dir never created')
  }
})

test('data-dir lock: a pid of another user is stale', async (t) => {
  await testnet(t)
  let eperm = false
  try { process.kill(1, 0) } catch (err) { eperm = err.code === 'EPERM' }
  if (!eperm) {
    // e.g. running as root, or a pid namespace where pid 1 is ours
    t.comment('skipped: process.kill(1, 0) does not throw EPERM here')
    t.pass()
    return
  }
  const dir = tmpDir(t)
  plantLock(dir, '1\n')
  const s = await open(t, dir)
  t.is(ownerPid(dir), process.pid)
  await s.closeOnce()
})

test('data-dir lock: a pid-less lock with a future mtime is stale', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  fs.mkdirSync(lockDir(dir))
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(lockDir(dir), future, future)
  const started = Date.now()
  const s = await open(t, dir)
  t.ok(Date.now() - started < 1000, 'taken over without waiting')
  t.is(ownerPid(dir), process.pid)
  await s.closeOnce()
})

test('openStore refuses a symlink at <data>/store, allows a symlinked data dir', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const target = tmpDir(t)
  fs.chmodSync(target, 0o755)
  fs.symlinkSync(target, path.join(dir, 'store'))
  try {
    await store.openStore(dir)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'STORE_INVALID')
    t.ok(/link simbólico/.test(err.message), err.message)
  }
  t.is(fs.statSync(target).mode & 0o777, 0o755, 'target not chmodded')
  t.alike(fs.readdirSync(target), [], 'nothing written into the target')
  t.absent(fs.existsSync(lockDir(dir)), 'lock released')

  const real = tmpDir(t)
  const link = path.join(tmpDir(t), 'dados')
  fs.symlinkSync(real, link)
  const s = await open(t, link)
  t.ok(fs.existsSync(path.join(real, 'store')))
  await s.closeOnce()
})

test('writeJsonAtomic fsyncs the parent directory', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const file = path.join(dir, 'follows.json')
  const { openSync, fsyncSync } = fs
  t.teardown(() => { fs.openSync = openSync; fs.fsyncSync = fsyncSync }, { force: true })
  const dirFds = new Set()
  const synced = []
  let fail = null
  fs.openSync = function (p, ...rest) {
    const fd = openSync.call(fs, p, ...rest)
    // fd numbers are reused after close: track only the current dir opens
    if (p === dir) dirFds.add(fd)
    else dirFds.delete(fd)
    return fd
  }
  fs.fsyncSync = function (fd) {
    if (dirFds.has(fd)) {
      synced.push(fd)
      if (fail) {
        const err = new Error('simulado')
        err.code = fail
        throw err
      }
    }
    return fsyncSync.call(fs, fd)
  }

  store.writeJsonAtomic(file, { a: 1 })
  t.is(synced.length, 1, 'parent fsynced once')

  fail = 'EINVAL'
  store.writeJsonAtomic(file, { a: 2 })
  t.alike(store.readJson(file, null), { a: 2 }, 'EINVAL is tolerated')

  fail = 'EIO'
  t.exception(() => store.writeJsonAtomic(file, { a: 3 }), /simulado/)
  t.alike(store.readJson(file, null), { a: 3 }, 'already published')
  fs.openSync = openSync
  fs.fsyncSync = fsyncSync
})

test('data-dir lock: a failing close keeps the lock', async (t) => {
  await testnet(t)
  const Corestore = require('corestore')
  const dir = tmpDir(t)
  const own = Object.prototype.hasOwnProperty.call(Corestore.prototype, 'close')
  const orig = Corestore.prototype.close
  let fail = true
  Corestore.prototype.close = function (...args) {
    if (fail) return Promise.reject(new Error('falha simulada'))
    return orig.apply(this, args)
  }
  const restore = () => {
    if (own) Corestore.prototype.close = orig
    else delete Corestore.prototype.close
  }
  const s = await store.openStore(dir)
  t.teardown(async () => {
    fail = false
    try { await s.close() } catch {}
    restore()
  }, { force: true })

  await t.exception(() => s.close(), /falha simulada/)
  t.is(ownerPid(dir), process.pid, 'lock still held')
  await t.exception(() => store.openStore(dir), /diretório de dados em uso/)

  fail = false
  await s.close()
  restore()
  t.absent(fs.existsSync(lockDir(dir)), 'released after a successful close')
})

// The interleaving behind a flake of the 30-process race on Linux, replayed
// in one process: our opener inspects an owner-less stale lock; before its
// takeover re-checks the lock under the mutex, another opener removes the
// stale dir and a third one mkdirs a fresh lock dir on the SAME inode number
// (Linux reuses a freed inode at once; lstat is stubbed to report it) and
// has not written its owner yet. Same dev, ino and (absent) owner content:
// only the mtime tells the fresh lock from the stale one. A takeover that
// removed it would leave two holders.
test('data-dir lock: a takeover never removes a younger lock on a reused inode', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const lock = lockDir(dir)
  fs.mkdirSync(lock)
  age(lock)
  const stale = fs.lstatSync(lock)
  // The third opener: alive, it publishes its owner a moment later.
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  t.teardown(() => owner.kill('SIGKILL'), { force: true })

  const realLstat = fs.lstatSync
  let lockCalls = 0
  let fresh = null // real { dev, ino } of the fresh lock dir
  fs.lstatSync = function (p, ...rest) {
    if (p === lock && ++lockCalls === 2) {
      // Between our inspection and our takeover's re-check.
      fs.rmSync(lock, { recursive: true })
      fs.mkdirSync(lock)
      const st = realLstat.call(fs, lock)
      fresh = { dev: st.dev, ino: st.ino }
      setTimeout(() => {
        try { fs.writeFileSync(path.join(lock, 'pid'), owner.pid + ' ' + 'ab'.repeat(16) + '\n') } catch {}
      }, 100)
    }
    const st = realLstat.call(fs, p, ...rest)
    // The fresh dir has the stale dir's inode number, wherever it is moved.
    if (fresh !== null && st.dev === fresh.dev && st.ino === fresh.ino) {
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: stale.ino })
    }
    return st
  }
  t.teardown(() => { fs.lstatSync = realLstat }, { force: true })

  let opened = null
  let error = null
  try {
    opened = await store.openStore(dir)
  } catch (err) {
    error = err
  }
  fs.lstatSync = realLstat
  if (opened !== null) await opened.close()
  t.ok(lockCalls >= 2, 'the takeover re-checked the lock')
  t.is(error && error.code, 'LOCKED', 'the younger lock wins: LOCKED')
  t.ok(fs.existsSync(lock), 'the younger lock dir is still there')
  t.is(fs.existsSync(path.join(lock, 'pid')) ? ownerPid(dir) : null, owner.pid, 'with its own owner')
  t.alike(leftovers(dir), [], 'no aside copy or mutex left')
})

test('data-dir lock: 30 processes racing over a stale lock, one wins', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  fs.mkdirSync(lockDir(dir))
  age(lockDir(dir))
  const go = path.join(tmpDir(t), 'go')
  const script = 'const fs = require("node:fs");' +
    'const s = require(' + JSON.stringify(require.resolve('../lib/store')) + ');' +
    'const [dir, go] = process.argv.slice(1);' +
    'process.stdout.write("ready\\n");' +
    'const start = () => s.openStore(dir).then((st) => {' +
    '  process.stdout.write("ok\\n");' +
    '  process.stdin.on("end", () => st.close().then(() => process.exit(0)));' +
    '  process.stdin.resume()' +
    '}, (err) => { process.stdout.write((err.code || err.message) + "\\n"); process.exit(0) });' +
    'const wait = () => fs.existsSync(go) ? start() : setTimeout(wait, 5);' +
    'wait()'
  const children = []
  for (let i = 0; i < 30; i++) {
    const child = spawn(process.execPath, ['-e', script, dir, go], { stdio: ['pipe', 'pipe', 'pipe'] })
    const c = { child, lines: [], stderr: '', waiters: [] }
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const parts = buf.split('\n')
      buf = parts.pop()
      c.lines.push(...parts)
      for (const w of c.waiters.splice(0)) w()
    })
    child.stderr.on('data', (d) => { c.stderr += d })
    c.closed = new Promise((resolve) => child.on('close', resolve))
    children.push(c)
  }
  t.teardown(() => { for (const c of children) c.child.kill('SIGKILL') }, { force: true })
  const lineCount = (c, n) => new Promise((resolve) => {
    const check = () => (c.lines.length >= n ? resolve() : c.waiters.push(check))
    check()
  })

  await Promise.all(children.map((c) => lineCount(c, 1)))
  fs.writeFileSync(go, '')
  await Promise.all(children.map((c) => lineCount(c, 2)))
  const verdicts = children.map((c) => c.lines[1])
  const winners = verdicts.filter((v) => v === 'ok')
  t.is(winners.length, 1, 'exactly one winner: ' + verdicts.join(','))
  t.is(verdicts.filter((v) => v === 'LOCKED').length, 29, children.map((c) => c.stderr).join(''))
  const winner = children[verdicts.indexOf('ok')]
  t.is(ownerPid(dir), winner.child.pid)
  t.alike(leftovers(dir), [], 'no stale copy or mutex left')

  for (const c of children) c.child.stdin.end()
  const codes = await Promise.all(children.map((c) => c.closed))
  t.alike(codes, new Array(30).fill(0))
  t.absent(fs.existsSync(lockDir(dir)), 'winner released it')
})

test('appendRecord refuses appends over the diary limits', async (t) => {
  await testnet(t)
  const s = await open(t, tmpDir(t))
  const diary = await store.openDiary(s)
  const hex = b4a.toString(diary.key, 'hex')
  await store.appendRecord(diary, memberCertRecord(certFixture(hex)))
  const post = postRecord({ text: 'x'.repeat(200), at: AT })
  const postBytes = b4a.byteLength(JSON.stringify(post))

  // block size
  await t.exception(() => store.appendRecord(diary, post, { maxBlockBytes: postBytes - 1 }), /limite do diário atingido/)
  t.is(await store.appendRecord(diary, post, { maxBlockBytes: postBytes }), 1)

  // block count
  await t.exception(() => store.appendRecord(diary, post, { maxLogBlocks: 2 }), /limite do diário atingido/)
  t.is(await store.appendRecord(diary, post, { maxLogBlocks: 3 }), 2)

  // log bytes
  const bytes = diary.byteLength
  t.ok(bytes > 0)
  await t.exception(() => store.appendRecord(diary, post, { maxLogBytes: bytes + postBytes - 1 }), /limite do diário atingido/)
  t.is(await store.appendRecord(diary, post, { maxLogBytes: bytes + postBytes }), 3)
  t.is(diary.byteLength, bytes + postBytes)
  t.is(diary.length, 4)

  // validation errors still come first
  await t.exception(() => store.appendRecord(diary, memberCertRecord(certFixture(hex)), { maxLogBlocks: 1 }), /cert-not-first/)
})

test('data-dir lock: released on process exit without close', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const code = 'require(' + JSON.stringify(require.resolve('../lib/store')) + ').openStore(' +
    JSON.stringify(dir) + ').then(() => process.exit(0))'
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 60000 })
  t.is(r.status, 0, r.stderr)
  t.absent(fs.existsSync(lockDir(dir)), 'exit hook removed the lock')
  const s = await open(t, dir)
  await s.closeOnce()
})
