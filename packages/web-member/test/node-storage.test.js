// The browser node storage (lib/node-storage.js) on IndexedDB, through
// fake-indexeddb in Node: paged files (reads and writes across pages, del,
// truncate, reopen), whole cores (hasCore, deleteCore), the key-value area,
// and a Hypercore 10 diary that survives closing and reopening the database
// with the same key and blocks while the storage never holds the secret key
// (the key pair is handed to openDiary in memory, lib/node-store.js). The
// memory twin is held to the same core-level behaviour. Lazy mode (a media
// core's 'data' file): randomized concurrent interleavings against a
// reference buffer with a two-page cache, and a Hypercore 10 core whose
// blocks survive a reopen while the cache stays bounded.
require('fake-indexeddb/auto')
/* global indexedDB, IDBKeyRange */
const test = require('brittle')
const b4a = require('b4a')
const { createHash } = require('node:crypto')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { idbNodeStorage, memoryNodeStorage, PAGE_SIZE, DEFAULT_CACHE_PAGES } = require('../lib/node-storage')
const { openDiary, diaryStatus, appendRecord, readAll, readBlocklist, writeBlocklist } = require('../lib/node-store')
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

test('blocklist kv: round trip, absent and malformed are null, survives deleting the diary', async (t) => {
  await testnet(t, 1)
  const storage = await idbNodeStorage(dbName())
  t.is(await readBlocklist(storage), null, 'absent')
  const snapshot = { v: 1, seq: 2, blocked: ['a'.repeat(64)] }
  await writeBlocklist(storage, snapshot)
  t.alike(await readBlocklist(storage), { v: 1, snapshot })
  for (const bad of ['x', [], { v: 2, snapshot: {} }, { v: 1 }, { v: 1, snapshot: [] }, { v: 1, snapshot: null }]) {
    await storage.writeJson('blocklist', bad)
    t.is(await readBlocklist(storage), null, 'malformed')
  }
  // A value that is not JSON at all reads as absent; a storage failure throws.
  const torn = { readJson: async () => { throw new SyntaxError('Unexpected token') } }
  t.is(await readBlocklist(torn), null, 'unparseable value is null')
  const broken = { readJson: async () => { throw new Error('ler blocklist: falha') } }
  await t.exception(readBlocklist(broken), /falha/, 'an IndexedDB error still throws')
  await writeBlocklist(storage, snapshot)
  const diary = await openDiary(storage, crypto.keyPair())
  await diary.close()
  await storage.deleteCore('diary')
  t.alike(await readBlocklist(storage), { v: 1, snapshot }, 'the diary reset keeps it')
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

// ---- lazy mode -------------------------------------------------------------

// The 'pages' keys of one core straight from IndexedDB.
function pageKeys (name, core) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['pages'], 'readonly')
      const all = tx.objectStore('pages').getAllKeys(IDBKeyRange.bound([core], [core, []]))
      all.onsuccess = () => {
        db.close()
        resolve(all.result)
      }
      all.onerror = () => reject(all.error)
    }
  })
}

// Deterministic PRNG (mulberry32): the seed is printed, so a failing
// interleaving can be replayed with VARANDA_LAZY_SEED.
function prng (seed) {
  let s = seed >>> 0
  return function next (n) {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
}

// The reference: the operations applied one after the other, in issue order.
class Reference {
  constructor () {
    this.buf = b4a.alloc(0)
  }

  get length () { return this.buf.length }

  write (offset, data) {
    const end = offset + data.length
    if (end > this.buf.length) this.buf = b4a.concat([this.buf, b4a.alloc(end - this.buf.length)])
    this.buf.set(data, offset)
  }

  read (offset, size) {
    if (offset + size > this.buf.length) return null
    return b4a.from(this.buf.subarray(offset, offset + size))
  }

  truncate (length) {
    if (length <= this.buf.length) this.buf = b4a.from(this.buf.subarray(0, length))
    else this.buf = b4a.concat([this.buf, b4a.alloc(length - this.buf.length)])
  }

  del (offset, size) {
    if (offset >= this.buf.length) return
    if (offset + size >= this.buf.length) return this.truncate(offset)
    this.buf.fill(0, offset, offset + size)
  }
}

// The pages the file holds in memory beyond the ones an operation is using.
function idleCache (file) {
  let busy = 0
  for (const e of file.cache.values()) if (e.pins > 0 || e.persisting > 0 || e.page === null) busy++
  return file.cache.size - busy
}

test('lazy file: randomized concurrent interleavings match issue order, with a two-page cache', async (t) => {
  await testnet(t, 1)
  const seed = Number(process.env.VARANDA_LAZY_SEED) || (Date.now() % 1000000)
  t.comment('seed ' + seed)
  const rnd = prng(seed)
  const name = dbName()
  const storage = await idbNodeStorage(name)
  const CORE = 'media/' + 'ab'.repeat(32)
  const SPAN = 6 * PAGE_SIZE
  const file = storage.core(CORE, { lazy: ['data'], cachePages: 2 })('data')
  const ref = new Reference()
  let maxIdle = 0
  let failures = 0

  for (let round = 0; round < 150 && failures === 0; round++) {
    const k = 1 + rnd(6)
    const pending = []
    for (let i = 0; i < k; i++) {
      const kind = rnd(10)
      if (kind < 4) {
        const offset = rnd(SPAN)
        const data = bytes(1 + rnd(Math.floor(2.5 * PAGE_SIZE)), rnd(256))
        ref.write(offset, data)
        pending.push(call(file, 'write', offset, data))
      } else if (kind < 8) {
        const offset = rnd(Math.max(1, ref.length))
        const size = rnd(Math.floor(2.5 * PAGE_SIZE))
        const expected = ref.read(offset, size)
        pending.push(call(file, 'read', offset, size).then((got) => {
          if (expected === null || !b4a.equals(got, expected)) failures++
        }, () => { if (expected !== null) failures++ }))
      } else if (kind < 9) {
        const length = rnd(SPAN)
        ref.truncate(length)
        pending.push(call(file, 'truncate', length))
      } else {
        const offset = rnd(SPAN)
        const size = rnd(Math.floor(2.5 * PAGE_SIZE))
        ref.del(offset, size)
        pending.push(call(file, 'del', offset, size))
      }
    }
    await Promise.all(pending)
    maxIdle = Math.max(maxIdle, idleCache(file))
    if ((await call(file, 'stat')).size !== ref.length) failures++
    if (ref.length > 0 && !b4a.equals(await call(file, 'read', 0, ref.length), ref.buf)) failures++
  }
  t.is(failures, 0, 'every read, length and whole-file check matched the reference')
  t.ok(maxIdle <= 2, 'the cache never kept more than two idle pages (' + maxIdle + ')')

  // Two reads of the same uncached page share one load.
  const page = Math.floor(ref.length / PAGE_SIZE) - 1
  if (page >= 0) {
    file.cache.clear()
    const a = call(file, 'read', page * PAGE_SIZE, 10)
    const b = call(file, 'read', page * PAGE_SIZE + 10, 10)
    t.is(file.cache.size, 1, 'one entry for the two concurrent loads')
    t.alike(b4a.concat([await a, await b]), ref.read(page * PAGE_SIZE, 20))
  }

  await call(file, 'close')
  await storage.close()
  const again = await idbNodeStorage(name)
  const reopened = again.core(CORE, { lazy: ['data'], cachePages: 2 })('data')
  t.is((await call(reopened, 'stat')).size, ref.length, 'length survives a reopen')
  if (ref.length > 0) t.alike(await call(reopened, 'read', 0, ref.length), ref.buf, 'bytes survive a reopen')
  await call(reopened, 'close')
  await again.close()
  const keys = await pageKeys(name, CORE)
  t.ok(keys.every((k) => k[2] < Math.ceil(ref.length / PAGE_SIZE)), 'no page row past the length')
})

test('lazy file: options, holes, truncate tail and the memory twin', async (t) => {
  await testnet(t, 1)
  const storage = await idbNodeStorage(dbName())
  t.exception.all(() => storage.core('media/x', { lazy: 'data' }), /lazy must be/)
  t.exception.all(() => storage.core('media/x', { cachePages: 0 }), /cachePages/)
  const whole = storage.core('media/x', { lazy: ['data'] })('tree')
  t.is(whole.cache, undefined, 'other files keep whole-file mode')
  const file = storage.core('media/x', { lazy: ['data'] })('data')
  t.is(file.cachePages, DEFAULT_CACHE_PAGES)
  await call(file, 'write', 3 * PAGE_SIZE, b4a.from('fim'))
  t.alike(await call(file, 'read', PAGE_SIZE, 5), b4a.alloc(5), 'a hole reads as zeros')
  await t.exception(call(file, 'read', 3 * PAGE_SIZE, 4), /além do fim/)
  await call(file, 'truncate', 3 * PAGE_SIZE + 1)
  t.alike(await call(file, 'read', 3 * PAGE_SIZE, 1), b4a.from('f'))
  await call(file, 'truncate', 3 * PAGE_SIZE + 3)
  t.alike(await call(file, 'read', 3 * PAGE_SIZE, 3), b4a.from('f\0\0'), 'growing again never resurrects the old tail')
  await call(file, 'close')
  t.ok(await storage.hasCore('media/x'))
  await storage.deleteCore('media/x')
  const gone = storage.core('media/x', { lazy: ['data'] })('data')
  t.is((await call(gone, 'stat')).size, 0, 'a deleted core reopens empty')
  await call(gone, 'close')
  await storage.close()
  const memory = memoryNodeStorage()
  const ram = memory.core('media/x', { lazy: ['data'] })('data')
  await call(ram, 'write', 0, b4a.from('ok'))
  t.alike(await call(ram, 'read', 0, 2), b4a.from('ok'), 'the memory twin accepts and ignores lazy')
})

// The lazy file's database connection with the next readwrite range delete
// on 'pages' failing (the transaction aborts), once.
function failNextRangeDelete (file) {
  const db = file.owner.db
  let armed = true
  file.owner = {
    db: {
      transaction (names, mode) {
        const tx = db.transaction(names, mode)
        if (mode !== 'readwrite' || !armed) return tx
        const objectStore = tx.objectStore.bind(tx)
        tx.objectStore = (name) => {
          const store = objectStore(name)
          if (name !== 'pages') return store
          return {
            put: (value, key) => store.put(value, key),
            delete: (key) => {
              if (!(key instanceof IDBKeyRange)) return store.delete(key)
              armed = false
              throw new Error('falha simulada no apagamento')
            }
          }
        }
        return tx
      }
    }
  }
}

test('lazy file: a truncate whose page deletion fails still waits for its tail page, so nothing is written after close or deleteCore', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const CORE = 'media/x'
  let storage = await idbNodeStorage(name)
  let file = storage.core(CORE, { lazy: ['data'], cachePages: 1 })('data')
  const data = bytes(2 * PAGE_SIZE, 9)
  await call(file, 'write', 0, data)
  t.is(file.cache.size, 1, 'a one-page cache: page 0 is out, page 1 cached')
  t.ok(file.cache.has(1))
  failNextRangeDelete(file)
  await t.exception(call(file, 'truncate', 1), /gravar data/, 'the truncate fails')
  t.is(file.inflight.size, 0, 'and answers only once all of its work settled')
  await call(file, 'close')
  t.is(file.persists.size, 0)
  await t.exception(file._persist([], null), /fechado/, 'no persist may start after close')
  await storage.deleteCore(CORE)
  t.absent(await storage.hasCore(CORE))
  await storage.close()
  t.alike(await pageKeys(name, CORE), [], 'no page of the core is left behind')

  storage = await idbNodeStorage(name)
  t.absent(await storage.hasCore(CORE), 'the deleted core stays deleted')
  file = storage.core(CORE, { lazy: ['data'], cachePages: 1 })('data')
  t.is((await call(file, 'stat')).size, 0, 'it reopens empty')
  await call(file, 'close')
  await storage.close()
})

test('lazy file: close waits for an in-flight load, and the read still answers', async (t) => {
  await testnet(t, 1)
  const storage = await idbNodeStorage(dbName())
  const file = storage.core('media/x', { lazy: ['data'], cachePages: 2 })('data')
  const data = bytes(PAGE_SIZE + 7, 3)
  await call(file, 'write', 0, data)
  file.cache.clear()
  const read = call(file, 'read', PAGE_SIZE - 3, 10)
  const closed = call(file, 'close')
  t.is(file.cache.size, 2, 'both pages are loading when close is asked')
  t.alike(await read, data.subarray(PAGE_SIZE - 3, PAGE_SIZE + 7), 'the read answers with the data')
  await closed
  t.is(file.inflight.size, 0)
  t.is(file.cache.size, 0, 'the cache is released by close')
  await t.exception(call(file, 'read', 0, 1), /Closed/, 'and the file is closed')
  await storage.close()
})

test('a Hypercore 10 core over a lazy data file: 200 blocks of 32 KiB in bursts, reopen, bounded cache', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const CORE = 'media/' + 'cd'.repeat(32)
  const CACHE = 8
  const rnd = prng(7)
  function tracked (storage) {
    const files = {}
    const inner = storage.core(CORE, { lazy: ['data'], cachePages: CACHE })
    return { files, factory: (file) => (files[file] = inner(file)) }
  }
  let storage = await idbNodeStorage(name)
  let { files, factory } = tracked(storage)
  let core = new Hypercore(factory, { valueEncoding: 'binary' })
  await core.ready()
  t.ok(files.data.cache instanceof Map, 'the data file is lazy')
  t.is(files.tree.cache, undefined, 'the tree is not')
  const key = core.key
  const hashes = []
  let maxIdle = 0
  for (let burst = 0; burst < 20; burst++) {
    const blocks = []
    for (let i = 0; i < 10; i++) {
      const block = b4a.alloc(32768)
      for (let j = 0; j < block.length; j += 4) block.writeUInt32LE(rnd(0x100000000), j)
      blocks.push(block)
      hashes.push(createHash('sha256').update(block).digest('hex'))
    }
    await Promise.all(blocks.map((block) => core.append(block)))
    maxIdle = Math.max(maxIdle, idleCache(files.data))
  }
  t.is(core.length, 200)
  t.ok(maxIdle <= CACHE, 'idle cache within ' + CACHE + ' pages while appending (' + maxIdle + ')')
  await core.close()
  await storage.close()

  storage = await idbNodeStorage(name)
  ;({ files, factory } = tracked(storage))
  core = new Hypercore(factory, key, { valueEncoding: 'binary' })
  await core.ready()
  t.is(core.length, 200, 'same length after the reopen')
  let mismatched = 0
  for (let i = 0; i < 200; i += 10) {
    const got = await Promise.all(Array.from({ length: 10 }, (_, j) => core.get(i + j)))
    got.forEach((block, j) => { if (createHash('sha256').update(block).digest('hex') !== hashes[i + j]) mismatched++ })
    maxIdle = Math.max(maxIdle, idleCache(files.data))
  }
  t.is(mismatched, 0, 'every block equal by hash')
  t.ok(maxIdle <= CACHE, 'idle cache within ' + CACHE + ' pages while reading (' + maxIdle + ')')
  await core.clear(0, 10)
  t.absent(await core.has(5), 'cleared blocks are gone')
  t.is(createHash('sha256').update(await core.get(10)).digest('hex'), hashes[10], 'the others stay')
  await core.close()
  await storage.close()
})
