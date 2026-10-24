// The browser node storage (lib/node-storage.js) on IndexedDB, through
// fake-indexeddb in Node: paged files (reads and writes across pages, del,
// truncate, reopen), whole cores (hasCore, deleteCore), the key-value area,
// and a Hypercore 10 diary that survives closing and reopening the database
// with the same key and blocks while the storage never holds the secret key
// (the key pair is handed to openDiary in memory, lib/node-store.js). The
// memory twin is held to the same core-level behaviour.
require('fake-indexeddb/auto')
/* global indexedDB, IDBKeyRange */
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { idbNodeStorage, memoryNodeStorage, PAGE_SIZE } = require('../lib/node-storage')
const { openDiary, diaryStatus, appendRecord, readAll } = require('../lib/node-store')
const { postRecord } = require('@varanda/core/lib/records')
const { testnet } = require('./helpers/net')

const CORE_FILES = ['oplog', 'tree', 'bitfield', 'data', 'header']
const OPLOG_SLOT = 4096 // hypercore 10.38.2 lib/oplog.js pageSize: the second header slot's offset

let dbCount = 0
function dbName () {
  return 'varanda-test-' + process.pid + '-' + (++dbCount)
}

function call (file, method, ...args) {
  return new Promise((resolve, reject) => {
    file[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}

function bytes (n, seed) {
  const out = b4a.alloc(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

// Every byte of every file of the 'diary' core as the storage holds it
// (both oplog header slots included): a byte string per file.
async function diaryFiles (storage) {
  const out = {}
  for (const name of CORE_FILES) {
    const file = storage.core('diary')(name)
    const { size } = await call(file, 'stat')
    out[name] = size > 0 ? await call(file, 'read', 0, size) : b4a.alloc(0)
    await call(file, 'close')
  }
  return out
}

// The raw 'pages' rows of the 'diary' core straight from IndexedDB.
function diaryPages (name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['pages'], 'readonly')
      const all = tx.objectStore('pages').getAll(IDBKeyRange.bound(['diary'], ['diary', []]))
      all.onsuccess = () => {
        db.close()
        resolve(all.result.map((p) => new Uint8Array(p)))
      }
      all.onerror = () => reject(all.error)
    }
  })
}

function holds (buffers, needle) {
  return Object.values(buffers).some((buf) => b4a.indexOf(buf, needle) !== -1)
}

test('paged files: writes and reads across pages, del, truncate and reopen', async (t) => {
  await testnet(t, 1) // the helpers' rule: every file creates its testnet
  const name = dbName()
  const storage = await idbNodeStorage(name)
  const file = storage.core('diary')('data')
  const a = bytes(PAGE_SIZE + 100, 1)
  await call(file, 'write', PAGE_SIZE - 50, a)
  t.is((await call(file, 'stat')).size, PAGE_SIZE - 50 + a.length)
  t.alike(await call(file, 'read', PAGE_SIZE - 50, a.length), a, 'read across three pages')
  t.alike(await call(file, 'read', 0, 10), b4a.alloc(10), 'the hole reads as zeros')
  await t.exception(call(file, 'read', 2 * PAGE_SIZE, 1000), /além do fim/, 'read past the end fails')

  await call(file, 'del', PAGE_SIZE, 10)
  const afterDel = await call(file, 'read', PAGE_SIZE - 50, 60)
  t.alike(afterDel.subarray(50, 60), b4a.alloc(10), 'del clears a range in the middle')
  t.alike(afterDel.subarray(0, 50), a.subarray(0, 50))

  await call(file, 'truncate', PAGE_SIZE + 5)
  t.is((await call(file, 'stat')).size, PAGE_SIZE + 5)
  await call(file, 'del', PAGE_SIZE, 100)
  t.is((await call(file, 'stat')).size, PAGE_SIZE, 'a del that reaches the end truncates')
  await call(file, 'close')
  await storage.close()

  const again = await idbNodeStorage(name)
  const reopened = again.core('diary')('data')
  t.is((await call(reopened, 'stat')).size, PAGE_SIZE, 'length survives a reopen')
  t.alike(await call(reopened, 'read', PAGE_SIZE - 50, 50), a.subarray(0, 50), 'bytes survive a reopen')
  // Growing again after a truncate never resurrects the old tail.
  await call(reopened, 'truncate', PAGE_SIZE + 20)
  t.alike(await call(reopened, 'read', PAGE_SIZE, 20), b4a.alloc(20))
  await call(reopened, 'close')
  await again.close()
})

test('cores and the key-value area', async (t) => {
  await testnet(t, 1)
  const storage = await idbNodeStorage(dbName())
  t.absent(await storage.hasCore('diary'))
  const f = storage.core('replica/aa')('oplog')
  await call(f, 'write', 0, b4a.from('x'))
  await call(f, 'close')
  t.ok(await storage.hasCore('replica/aa'))
  t.absent(await storage.hasCore('replica/a'), 'names are whole keys, not prefixes')
  t.absent(await storage.hasCore('diary'))
  await storage.deleteCore('replica/aa')
  t.absent(await storage.hasCore('replica/aa'))
  const g = storage.core('replica/aa')('oplog')
  t.is((await call(g, 'stat')).size, 0, 'a deleted core reopens empty')
  await call(g, 'close')

  t.is(await storage.readJson('config'), null)
  await storage.writeJson('config', { v: 1, role: 'member', association: 'ab' })
  t.alike(await storage.readJson('config'), { v: 1, role: 'member', association: 'ab' })
  await storage.close()
})

test('a Hypercore 10 diary on IndexedDB survives closing the database, without its secret', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const keyPair = crypto.keyPair()
  const publicHex = b4a.toString(keyPair.publicKey, 'hex')
  let storage = await idbNodeStorage(name)
  await t.exception(openDiary(storage), /identidade não encontrada/, 'no diary and no key pair: nothing is created')
  t.absent(await storage.hasCore('diary'))
  let diary = await openDiary(storage, keyPair)
  t.is(b4a.toString(diary.key, 'hex'), publicHex, 'the core key is the pair\'s public key (compat mode)')
  t.ok(diary.writable, 'unlocked in memory')
  // Block 0 is a certificate in real use; the record rules allow a post at
  // seq >= 1 only, so the test appends raw blocks first.
  await diary.append({ type: 'filler' })
  for (let i = 1; i <= 40; i++) await appendRecord(diary, postRecord({ text: 'post ' + i + ' ' + 'x'.repeat(500) }))
  t.is(diary.length, 41)
  await diary.close()
  t.absent(holds(await diaryFiles(storage), keyPair.secretKey), 'no file of the diary holds the secret after 41 flushes')
  t.ok(holds(await diaryFiles(storage), keyPair.publicKey), 'the public key is stored')
  await storage.close()
  t.absent(holds(await diaryPages(name), keyPair.secretKey), 'no IndexedDB page of the diary holds the secret')

  storage = await idbNodeStorage(name)
  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: false })
  diary = await openDiary(storage)
  t.is(b4a.toString(diary.key, 'hex'), publicHex, 'same key after reopening')
  t.is(diary.length, 41, 'same length')
  t.absent(diary.writable, 'locked without the pair')
  const entries = await readAll(diary)
  t.is(entries[40].record.text, 'post 40 ' + 'x'.repeat(500), 'reads work locked')
  const locked = await appendRecord(diary, postRecord({ text: 'trancado' })).catch((err) => err)
  t.is(locked.code, 'USAGE')
  t.is(locked.message, 'identidade bloqueada: entre com a passkey')
  await diary.close()

  const other = await openDiary(storage, crypto.keyPair()).catch((err) => err)
  t.is(other.code, 'USAGE')
  t.is(other.message, 'passkey não corresponde ao diário guardado')
  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: false }, 'a refused open changes nothing')

  diary = await openDiary(storage, keyPair)
  t.ok(diary.writable, 'unlocked again with the pair')
  await appendRecord(diary, postRecord({ text: 'depois de reabrir' }))
  t.is(diary.length, 42)
  await diary.close()
  t.absent(holds(await diaryFiles(storage), keyPair.secretKey), 'still no secret after the reopen and append')
  await storage.close()
  t.absent(holds(await diaryPages(name), keyPair.secretKey))
})

// A diary created before the key moved to memory: hypercore generated the
// pair and stored it in the oplog header (both slots, after a few flushes).
async function legacyStore (storage, { empty = false } = {}) {
  const legacy = new Hypercore(storage.core('diary'), { valueEncoding: 'json' })
  await legacy.ready()
  const secret = b4a.from(legacy.keyPair.secretKey)
  const publicHex = b4a.toString(legacy.key, 'hex')
  if (!empty) {
    await legacy.append({ type: 'filler' })
    for (let i = 1; i <= 5; i++) await legacy.append(postRecord({ text: 'antigo ' + i }))
  }
  await legacy.close()
  return { secret, publicHex }
}

// True when some file holds the whole secret or any 8-byte window of its
// seed half (an Ed25519 secret key is seed || public key, and the public
// key is stored legitimately).
function holdsWindow (buffers, secret) {
  if (holds(buffers, secret)) return true
  for (let i = 0; i + 8 <= 32; i++) {
    if (holds(buffers, secret.subarray(i, i + 8))) return true
  }
  return false
}

// The memory storage with the 'diary' oplog's writes filtered through
// `shouldFail(offset, n)`: the n-th such write fails once.
function flakyOplog (storage, shouldFail) {
  let n = 0
  let failed = false
  const factory = storage.core.bind(storage)
  return {
    ...storage,
    core (name) {
      const files = factory(name)
      if (name !== 'diary') return files
      return (file) => {
        const ras = files(file)
        if (file !== 'oplog') return ras
        const original = ras.write.bind(ras)
        ras.write = (offset, data, cb) => {
          if (!failed && shouldFail(offset, ++n)) {
            failed = true
            cb(new Error('falha simulada na gravação ' + offset))
            return
          }
          original(offset, data, cb)
        }
        return ras
      }
    },
    get failed () {
      return failed
    }
  }
}

test('a legacy store (secret in the header) is wiped on the first open, stays readable, never writable', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  const { secret, publicHex } = await legacyStore(storage)
  t.ok(holds(await diaryFiles(storage), secret), 'the legacy store does hold its secret')

  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: true }, 'the first open reports legacy')
  t.absent(holdsWindow(await diaryFiles(storage), secret), 'and no file holds any 8-byte window of the secret any more (both oplog slots)')
  t.ok(holds(await diaryFiles(storage), b4a.from(publicHex, 'hex')), 'the public key stays')
  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: true }, 'the wipe is remembered for this storage until reset')

  const diary = await openDiary(storage)
  t.absent(diary.writable, 'Hypercore no longer has a secret to sign with')
  t.is(diary.length, 6)
  const entries = await readAll(diary)
  t.is(entries[5].record.text, 'antigo 5', 'reads work')
  const refused = await appendRecord(diary, postRecord({ text: 'x' })).catch((err) => err)
  t.is(refused.message, 'identidade bloqueada: entre com a passkey', 'writes stay refused')
  t.is(diary.length, 6)
  await diary.close()
  const mismatch = await openDiary(storage, crypto.keyPair()).catch((err) => err)
  t.is(mismatch.message, 'passkey não corresponde ao diário guardado', 'a passkey key never matches it')
  t.absent(holds(await diaryFiles(storage), secret), 'still no secret after further opens')
  await storage.deleteCore('diary')
  t.alike(await diaryStatus(storage), { exists: false, publicKey: null, legacy: false }, 'reset still works')
  t.absent(await storage.hasCore('diary'))
})

test('a scrub cut short after its first flush is finished by the next open', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  const { secret, publicHex } = await legacyStore(storage)
  // The same storage, with the SECOND oplog header write (the second
  // flush's slot) failing once: the active slot is secret-free, the other
  // still holds the whole secret.
  let headerWrites = 0
  const flaky = flakyOplog(storage, (offset) => (offset === 0 || offset === OPLOG_SLOT) && ++headerWrites === 2)
  const err = await openDiary(flaky).catch((e) => e)
  t.ok(err instanceof Error && /falha simulada/.test(err.message), 'the interrupted scrub fails that open')
  t.ok(flaky.failed)
  t.ok(holds(await diaryFiles(storage), secret), 'the alternate slot still holds the secret')

  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: true }, 'the next open sees the raw slot and finishes the scrub')
  t.absent(holdsWindow(await diaryFiles(storage), secret), 'no file holds any 8-byte window of the secret after it (both slots)')
  const diary = await openDiary(storage)
  t.absent(diary.writable)
  t.is((await readAll(diary)).length, 6, 'the diary is still readable')
  await diary.close()
  t.absent(holdsWindow(await diaryFiles(storage), secret))
})

test('a scrub cut short before its tail writes is finished by the next open', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  // An empty legacy diary: little follows the key pair in the header, so
  // the stale tail of the old, longer encoding overlaps the secret.
  const { secret, publicHex } = await legacyStore(storage, { empty: true })
  t.ok(holds(await diaryFiles(storage), secret))
  // The FIRST tail-zeroing write fails once (both header flushes succeed).
  const flaky = flakyOplog(storage, (offset) => offset !== 0 && offset !== OPLOG_SLOT && offset < 2 * OPLOG_SLOT)
  const err = await openDiary(flaky).catch((e) => e)
  t.ok(err instanceof Error && /falha simulada/.test(err.message), 'the interrupted scrub fails that open')
  t.ok(flaky.failed)
  t.absent(holds(await diaryFiles(storage), secret), 'neither header holds the whole secret any more')
  t.ok(holdsWindow(await diaryFiles(storage), secret), 'but the stale tail still leaks part of it')

  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: false }, 'a mere tail cleanup is not reported as legacy')
  t.absent(holdsWindow(await diaryFiles(storage), secret), 'no file holds any 8-byte window of the secret after the next open')
  const diary = await openDiary(storage)
  t.absent(diary.writable)
  t.is(diary.length, 0, 'the (empty) diary is still readable')
  t.alike(await readAll(diary), [])
  await diary.close()
  t.absent(holdsWindow(await diaryFiles(storage), secret))
})

test('a legacy store on IndexedDB: no page holds the secret after the first open', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  let storage = await idbNodeStorage(name)
  const { secret, publicHex } = await legacyStore(storage)
  await storage.close()
  t.ok(holds(await diaryPages(name), secret), 'the legacy pages hold the secret')

  storage = await idbNodeStorage(name)
  t.alike(await diaryStatus(storage), { exists: true, publicKey: publicHex, legacy: true })
  await storage.close()
  t.absent(holdsWindow(await diaryPages(name), secret), 'no IndexedDB page of the diary holds any 8-byte window of the secret after the first open')
  t.ok(holds(await diaryPages(name), b4a.from(publicHex, 'hex')))

  storage = await idbNodeStorage(name)
  const diary = await openDiary(storage)
  t.absent(diary.writable)
  t.is((await readAll(diary)).length, 6, 'the diary survived the wipe')
  await diary.close()
  await storage.deleteCore('diary')
  t.absent(await storage.hasCore('diary'))
  await storage.close()
})

test('IndexedDB missing: a pt-BR error, never a fallback', async (t) => {
  await testnet(t, 1)
  const saved = globalThis.indexedDB
  globalThis.indexedDB = undefined
  t.teardown(() => { globalThis.indexedDB = saved })
  await t.exception(idbNodeStorage(dbName()), /IndexedDB\) indisponível/)
})

test('memory storage: same core behaviour', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  t.absent(await storage.hasCore('diary'))
  t.alike(await diaryStatus(storage), { exists: false, publicKey: null, legacy: false })
  const diary = await openDiary(storage, keyPair)
  const key = b4a.toString(diary.key, 'hex')
  t.is(key, b4a.toString(keyPair.publicKey, 'hex'))
  await diary.append({ type: 'filler' })
  for (let i = 1; i <= 5; i++) await appendRecord(diary, postRecord({ text: 'post ' + i }))
  await diary.close()
  t.ok(await storage.hasCore('diary'))
  t.absent(holds(await diaryFiles(storage), keyPair.secretKey), 'no memory file holds the secret')
  const again = await openDiary(storage)
  t.is(b4a.toString(again.key, 'hex'), key)
  t.is(again.length, 6)
  t.absent(again.writable)
  await again.close()
  await storage.deleteCore('diary')
  t.absent(await storage.hasCore('diary'))
  await storage.writeJson('follows', { v: 1, follows: [] })
  t.alike(await storage.readJson('follows'), { v: 1, follows: [] })
})
