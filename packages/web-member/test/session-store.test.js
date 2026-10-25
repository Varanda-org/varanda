// lib/session-store.js on fake-indexeddb with node:crypto's WebCrypto: the
// sealed PRF output round-trips, every mismatch or tampering (rp.id, public
// key, ciphertext, iv, version) returns null AND clears the store, a save
// replaces the previous record, clear() is idempotent, the stored AES key is
// non-extractable, and the stored record never holds the PRF bytes.
const test = require('brittle')
const { webcrypto } = require('node:crypto')
const { IDBFactory } = require('fake-indexeddb')
const { createSessionStore, MAX_IDLE_MS, STORE, RECORD_KEY } = require('../lib/session-store')

const DAY = 24 * 60 * 60 * 1000

const RP_ID = 'bora.varanda.app'
const PUBLIC_KEY = 'ab'.repeat(32)
const OTHER_KEY = 'cd'.repeat(32)
const CREDENTIAL_ID = 'AAECAwQFBgcICQoLDA0ODw'

function prfBytes (seed = 7) {
  return new Uint8Array(32).map((_, i) => (i * 13 + seed) & 0xff)
}

function setup () {
  const indexedDB = new IDBFactory()
  const store = createSessionStore({ indexedDB, crypto: webcrypto })
  return { indexedDB, store }
}

function openRaw (indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('varanda-session') // current version (1, or 2 after a repair)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function rawOp (indexedDB, mode, fn) {
  const db = await openRaw(indexedDB)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], mode)
      const req = fn(tx.objectStore(STORE))
      let value
      req.onsuccess = () => { value = req.result }
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

const readRaw = (indexedDB) => rawOp(indexedDB, 'readonly', (s) => s.get(RECORD_KEY))
const writeRaw = (indexedDB, record) => rawOp(indexedDB, 'readwrite', (s) => s.put(record, RECORD_KEY))

function contains (haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let j = 0
    while (j < needle.length && haystack[i + j] === needle[j]) j++
    if (j === needle.length) return true
  }
  return false
}

// Every typed array / ArrayBuffer reachable from the stored record.
function byteArrays (value, out = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return out
  seen.add(value)
  if (value instanceof ArrayBuffer) out.push(new Uint8Array(value))
  else if (ArrayBuffer.isView(value)) out.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  else for (const k of Object.keys(value)) byteArrays(value[k], out, seen)
  return out
}

async function saveDefault (store, prf = prfBytes()) {
  await store.save(prf, { rpId: RP_ID, credentialId: CREDENTIAL_ID, publicKey: PUBLIC_KEY })
}

test('round trip: load returns a fresh copy of the PRF output and the credential id', async (t) => {
  const { store } = setup()
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null, 'absent -> null')
  const prf = prfBytes()
  const before = prf.slice()
  await saveDefault(store, prf)
  t.alike(prf, before, 'save does not mutate prf')
  const out = await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })
  t.ok(out)
  t.ok(out.prf instanceof Uint8Array)
  t.is(out.prf.byteLength, 32)
  t.alike(out.prf, before)
  t.is(out.credentialId, CREDENTIAL_ID)
  out.prf.fill(0)
  const again = await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })
  t.alike(again.prf, before, 'zeroing a loaded copy leaves the store intact')
})

test('rp.id mismatch -> null and cleared', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store)
  t.is(await store.load({ rpId: 'other.varanda.app', publicKey: PUBLIC_KEY }), null)
  t.is(await readRaw(indexedDB), undefined, 'record cleared')
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null)
})

test('public key mismatch -> null and cleared', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store)
  t.is(await store.load({ rpId: RP_ID, publicKey: OTHER_KEY }), null)
  t.is(await readRaw(indexedDB), undefined, 'record cleared')
})

test('additional data binds rp.id and public key even if the record fields are rewritten', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store)
  const record = await readRaw(indexedDB)
  record.publicKey = OTHER_KEY
  await writeRaw(indexedDB, record)
  t.is(await store.load({ rpId: RP_ID, publicKey: OTHER_KEY }), null, 'authentication fails')
  t.is(await readRaw(indexedDB), undefined, 'record cleared')
})

test('tampered ciphertext -> null and cleared', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store)
  const record = await readRaw(indexedDB)
  record.ciphertext[0] ^= 1
  await writeRaw(indexedDB, record)
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null)
  t.is(await readRaw(indexedDB), undefined, 'record cleared')
})

test('tampered iv -> null and cleared', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store)
  const record = await readRaw(indexedDB)
  record.iv[0] ^= 1
  await writeRaw(indexedDB, record)
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null)
  t.is(await readRaw(indexedDB), undefined, 'record cleared')
})

test('malformed records -> null and cleared', async (t) => {
  const mutations = {
    version: (r) => { r.v = 2 },
    'short iv': (r) => { r.iv = r.iv.slice(0, 11) },
    'short ciphertext': (r) => { r.ciphertext = r.ciphertext.slice(0, 47) },
    'missing key': (r) => { delete r.key },
    'bad credential id': (r) => { r.credentialId = 'not base64url!' },
    'not an object': () => 'garbage'
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    const { indexedDB, store } = setup()
    await saveDefault(store)
    const record = await readRaw(indexedDB)
    const replaced = mutate(record)
    await writeRaw(indexedDB, replaced === undefined ? record : replaced)
    t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null, label + ' -> null')
    t.is(await readRaw(indexedDB), undefined, label + ' -> cleared')
  }
})

test('save replaces the previous record', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store, prfBytes(1))
  const first = await readRaw(indexedDB)
  await store.save(prfBytes(2), { rpId: RP_ID, credentialId: 'Zm9vYmFy', publicKey: OTHER_KEY })
  const second = await readRaw(indexedDB)
  t.not(first.key, second.key)
  t.unlike(first.iv, second.iv, 'fresh iv')
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null, 'old identity gone')
  await store.save(prfBytes(2), { rpId: RP_ID, credentialId: 'Zm9vYmFy', publicKey: OTHER_KEY })
  const out = await store.load({ rpId: RP_ID, publicKey: OTHER_KEY })
  t.alike(out.prf, prfBytes(2))
  t.is(out.credentialId, 'Zm9vYmFy')
})

test('clear is idempotent', async (t) => {
  const { indexedDB, store } = setup()
  await store.clear()
  await saveDefault(store)
  await store.clear()
  await store.clear()
  t.is(await readRaw(indexedDB), undefined)
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null)
})

test('the stored key is a non-extractable AES-GCM-256 CryptoKey', async (t) => {
  const { indexedDB, store } = setup()
  await saveDefault(store)
  const record = await readRaw(indexedDB)
  t.is(record.key.constructor.name, 'CryptoKey')
  t.is(record.key.extractable, false)
  t.is(record.key.algorithm.name, 'AES-GCM')
  t.is(record.key.algorithm.length, 256)
  await t.exception(webcrypto.subtle.exportKey('raw', record.key), 'export refused')
  t.is(record.v, 1)
  t.is(record.rpId, RP_ID)
  t.is(record.publicKey, PUBLIC_KEY)
  t.is(record.credentialId, CREDENTIAL_ID)
  t.is(record.iv.byteLength, 12)
})

test('the stored record never contains the PRF bytes', async (t) => {
  const { indexedDB, store } = setup()
  const prf = prfBytes(42)
  await saveDefault(store, prf)
  const record = await readRaw(indexedDB)
  const arrays = byteArrays(record)
  t.ok(arrays.length >= 2, 'iv and ciphertext scanned')
  for (const a of arrays) {
    t.absent(contains(a, prf), 'no full PRF sequence')
    t.absent(contains(a, prf.subarray(0, 8)), 'no 8-byte PRF prefix')
  }
  for (const v of Object.values(record)) {
    if (typeof v === 'string') t.absent(v.includes(Buffer.from(prf).toString('hex')), 'no PRF hex in strings')
  }
})

test('save rejects bad arguments and stores nothing', async (t) => {
  const { indexedDB, store } = setup()
  const meta = { rpId: RP_ID, credentialId: CREDENTIAL_ID, publicKey: PUBLIC_KEY }
  await t.exception.all(store.save(new Uint8Array(31), meta), /PRF/)
  await t.exception.all(store.save(prfBytes(), { ...meta, rpId: '' }), /rp\.id/)
  await t.exception.all(store.save(prfBytes(), { ...meta, credentialId: 'a+b' }), /passkey/)
  await t.exception.all(store.save(prfBytes(), { ...meta, publicKey: 'AB'.repeat(32) }), /chave/)
  await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }) // creates the db if absent
  t.is(await readRaw(indexedDB), undefined)
})

test('IndexedDB missing: load -> null, save throws', async (t) => {
  const store = createSessionStore({ indexedDB: null, crypto: webcrypto })
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null)
  await t.exception(saveDefault(store), /indisponível/)
})

test('expiry: 30 days + 1 ms idle -> null and cleared; exactly 30 days still resumes', async (t) => {
  let clock = 1_000_000_000_000
  const indexedDB = new IDBFactory()
  const store = createSessionStore({ indexedDB, crypto: webcrypto, now: () => clock })
  t.is(MAX_IDLE_MS, 30 * DAY)
  await saveDefault(store)
  t.is((await readRaw(indexedDB)).usedAt, clock, 'save sets usedAt')
  clock += MAX_IDLE_MS
  t.ok(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), 'at exactly 30 days')
  clock += MAX_IDLE_MS + 1
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null, '30 days + 1 ms after the last use')
  t.is(await readRaw(indexedDB), undefined, 'record cleared')
})

test('a load at 29 days resumes and refreshes usedAt', async (t) => {
  const start = 1_000_000_000_000
  let clock = start
  const indexedDB = new IDBFactory()
  const store = createSessionStore({ indexedDB, crypto: webcrypto, now: () => clock })
  const prf = prfBytes(3)
  await saveDefault(store, prf)
  clock = start + 29 * DAY
  t.alike((await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })).prf, prf)
  t.is((await readRaw(indexedDB)).usedAt, clock, 'usedAt refreshed')
  clock = start + 45 * DAY // > 30 days after the save, 16 after the refresh
  t.alike((await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })).prf, prf, 'still signed in')
})

test('maxIdleMs is injectable', async (t) => {
  let clock = 5000
  const store = createSessionStore({ indexedDB: new IDBFactory(), crypto: webcrypto, now: () => clock, maxIdleMs: 100 })
  await saveDefault(store)
  clock += 101
  t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null)
})

test('usedAt more than 1 day in the future -> null and cleared; within 1 day resumes', async (t) => {
  const clock = 1_000_000_000_000
  for (const [ahead, ok] of [[DAY, true], [DAY + 1, false]]) {
    const indexedDB = new IDBFactory()
    const store = createSessionStore({ indexedDB, crypto: webcrypto, now: () => clock })
    await saveDefault(store)
    const record = await readRaw(indexedDB)
    record.usedAt = clock + ahead
    await writeRaw(indexedDB, record)
    const out = await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })
    if (ok) t.ok(out, 'ahead by ' + ahead)
    else {
      t.is(out, null, 'ahead by ' + ahead)
      t.is(await readRaw(indexedDB), undefined, 'record cleared')
    }
  }
})

test('missing or malformed usedAt (an older record) -> null and cleared', async (t) => {
  for (const bad of [undefined, null, '2026-10-25T00:00:00.000Z', 1.5, -1, NaN]) {
    const { indexedDB, store } = setup()
    await saveDefault(store)
    const record = await readRaw(indexedDB)
    if (bad === undefined) delete record.usedAt
    else record.usedAt = bad
    await writeRaw(indexedDB, record)
    t.is(await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY }), null, String(bad))
    t.is(await readRaw(indexedDB), undefined, String(bad) + ' -> cleared')
  }
})

test('a database at version 1 without the store is repaired: save then load round-trips', async (t) => {
  const indexedDB = new IDBFactory()
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('varanda-session') // no version: v1, no store
    req.onsuccess = () => { req.result.close(); resolve() }
    req.onerror = () => reject(req.error)
  })
  const store = createSessionStore({ indexedDB, crypto: webcrypto })
  const prf = prfBytes(9)
  await saveDefault(store, prf)
  const out = await store.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })
  t.ok(out)
  t.alike(out.prf, prf)
  t.ok(await readRaw(indexedDB), 'record stored after the repair')
  const again = createSessionStore({ indexedDB, crypto: webcrypto })
  t.alike((await again.load({ rpId: RP_ID, publicKey: PUBLIC_KEY })).prf, prf, 'a later store opens the repaired (v2) database')
})
