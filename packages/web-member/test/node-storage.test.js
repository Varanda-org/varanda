// The browser node storage (lib/node-storage.js) on IndexedDB, through
// fake-indexeddb in Node: paged files (reads and writes across pages, del,
// truncate, reopen), whole cores (hasCore, deleteCore), the key-value area,
// and a Hypercore 10 diary that survives closing and reopening the database
// with the same key, blocks and signing key. The memory twin is held to the
// same core-level behaviour.
require('fake-indexeddb/auto')
const test = require('brittle')
const b4a = require('b4a')
const { idbNodeStorage, memoryNodeStorage, PAGE_SIZE } = require('../lib/node-storage')
const { openDiary, appendRecord, readAll } = require('../lib/node-store')
const { postRecord } = require('@varanda/core/lib/records')
const { testnet } = require('./helpers/net')

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

test('a Hypercore 10 diary on IndexedDB survives closing the database', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  let storage = await idbNodeStorage(name)
  let diary = await openDiary(storage)
  const key = b4a.toString(diary.key, 'hex')
  // Block 0 is a certificate in real use; the record rules allow a post at
  // seq >= 1 only, so the test appends raw blocks first.
  await diary.append({ type: 'filler' })
  for (let i = 1; i <= 40; i++) await appendRecord(diary, postRecord({ text: 'post ' + i + ' ' + 'x'.repeat(500) }))
  t.is(diary.length, 41)
  await diary.close()
  await storage.close()

  storage = await idbNodeStorage(name)
  diary = await openDiary(storage)
  t.is(b4a.toString(diary.key, 'hex'), key, 'same key after reopening')
  t.is(diary.length, 41, 'same length')
  t.ok(diary.writable, 'the signing key was persisted')
  const entries = await readAll(diary)
  t.is(entries[40].record.text, 'post 40 ' + 'x'.repeat(500))
  await appendRecord(diary, postRecord({ text: 'depois de reabrir' }))
  t.is(diary.length, 42)
  await diary.close()
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
  t.absent(await storage.hasCore('diary'))
  const diary = await openDiary(storage)
  const key = b4a.toString(diary.key, 'hex')
  await diary.append({ type: 'filler' })
  await diary.close()
  t.ok(await storage.hasCore('diary'))
  const again = await openDiary(storage)
  t.is(b4a.toString(again.key, 'hex'), key)
  t.is(again.length, 1)
  await again.close()
  await storage.deleteCore('diary')
  t.absent(await storage.hasCore('diary'))
  await storage.writeJson('follows', { v: 1, follows: [] })
  t.alike(await storage.readJson('follows'), { v: 1, follows: [] })
})
