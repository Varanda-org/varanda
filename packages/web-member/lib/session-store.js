// The persistent sign-in of the browser node: "stay signed in on this device
// until 'Sair'". The passkey's 32-byte PRF output (./passkey.js) is the root
// every member key is derived from, so keeping it lets a reload resume the
// session without a new passkey ceremony. This module is the deliberate,
// documented exception to the rule that no secret is ever stored
// (./node-store.js, scrubLegacySecret).
//
// What is protected:
//   - nothing secret is on disk in clear: the PRF output is sealed with
//     AES-GCM-256 under a fresh random 12-byte IV, and the additional data
//     binds it to this rp.id and this identity's public key
//     (utf8('varanda/session/v1\n' + rpId + '\n' + publicKey)), so a record
//     moved to another origin or identity does not open;
//   - the AES key is a CryptoKey generated with extractable: false, which
//     ONLY stops scripts from exporting its bytes through WebCrypto;
//   - the sign-in expires: a record not used for MAX_IDLE_MS (30 days) is
//     refused and erased on the next load (see usedAt below).
// What is NOT protected:
//   - the AES key is stored in the same browser profile (this IndexedDB) as
//     the ciphertext: a copy of the profile (malware on the device, a stolen
//     backup) yields the PRF output, and so the member's identity, until
//     'Sair' erases it or it sits 30 days unused;
//   - a script running on this origin can call decrypt with the stored key
//     and read the PRF output (an XSS is a full compromise of the signed-in
//     member, as it already is while the session is unlocked);
//   - anyone holding the unlocked device can act as the member until the
//     session is cleared or expires.
// 'Sair' (signOut) and the reset of the app call clear(), which erases the
// record and with it the only reference to the key.
//
// Expiry: the record's usedAt is the ms epoch (an integer, Date.now()) of the
// last save or successful load. load() refuses (clears, returns null) when
// now - usedAt > maxIdleMs, when usedAt is missing or not a non-negative safe
// integer, or when it is more than MAX_FUTURE_MS (1 day) ahead of now (clock
// tampering or skew fails closed). A successful load rewrites usedAt = now,
// best effort, and only if the stored record is still the one it read.
//
// Layout: its own IndexedDB database (default 'varanda-session', version 1;
// higher only after the missing-store repair in openDatabase,
// apart from the node storage so a reset of either never touches the other),
// one object store 'session' holding ONE record under 'current':
//   { v: 1, rpId, credentialId (base64url), publicKey (hex64),
//     iv (Uint8Array 12), ciphertext (Uint8Array 48), key: CryptoKey,
//     usedAt (ms epoch) }
//
// load() fails closed: an absent record is null, and any other problem (an
// unknown version, another rp.id or public key, an expired, missing or
// future usedAt, a malformed field, a failed authentication, an IndexedDB
// error) clears the store and returns null; it never throws for those. save() throws on bad arguments or a storage error.
//
// Browser-bundleable: no Node builtin; indexedDB and crypto (WebCrypto) are
// injected, globalThis by default.
const b4a = require('b4a')

const DB_VERSION = 1
const STORE = 'session'
const RECORD_KEY = 'current'
const VERSION = 1
const PRF_BYTES = 32
const IV_BYTES = 12
const TAG_BITS = 128
const CIPHERTEXT_BYTES = PRF_BYTES + TAG_BITS / 8
const AAD_LABEL = 'varanda/session/v1'
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_IDLE_MS = 30 * DAY_MS
const MAX_FUTURE_MS = DAY_MS

const HEX64 = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

function idbError (what, err) {
  const detail = err && typeof err.name === 'string' ? ' (' + err.name + ')' : ''
  return new Error('armazenamento da sessão (IndexedDB) falhou ao ' + what + detail)
}

function additionalData (rpId, publicKey) {
  return new Uint8Array(b4a.from(AAD_LABEL + '\n' + rpId + '\n' + publicKey, 'utf8'))
}

function validRpId (rpId) {
  return typeof rpId === 'string' && rpId !== '' && !rpId.includes('\n')
}

function validPublicKey (publicKey) {
  return typeof publicKey === 'string' && HEX64.test(publicKey)
}

function validCredentialId (credentialId) {
  return typeof credentialId === 'string' && BASE64URL.test(credentialId) && credentialId.length % 4 !== 1
}

function bytesOf (value, length) {
  return value instanceof Uint8Array && value.byteLength === length
}

function sameBytes (a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

function isSessionKey (key) {
  return key !== null && typeof key === 'object' &&
    key.type === 'secret' && key.extractable === false &&
    key.algorithm && key.algorithm.name === 'AES-GCM' && key.algorithm.length === 256 &&
    Array.isArray(key.usages) && key.usages.includes('decrypt')
}

function createSessionStore ({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, name = 'varanda-session', now = Date.now, maxIdleMs = MAX_IDLE_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('relógio inválido')
  if (!Number.isSafeInteger(maxIdleMs) || maxIdleMs <= 0) throw new TypeError('validade da sessão inválida')

  function clock () {
    const t = now()
    if (!Number.isSafeInteger(t) || t < 0) throw new Error('relógio inválido')
    return t
  }

  // A database that already exists without the store (opened elsewhere with
  // no version, so it sits at a version whose upgrade never created it) is
  // repaired by one reopen at db.version + 1; a database at a version above
  // DB_VERSION (after such a repair) is opened at its current version.
  async function openDatabase () {
    let db
    try {
      db = await openAt(DB_VERSION)
    } catch (err) {
      if (!err || err.idbName !== 'VersionError') throw err
      db = await openAt(undefined)
    }
    if (db.objectStoreNames.contains(STORE)) return db
    const next = db.version + 1
    db.close()
    db = await openAt(next)
    if (db.objectStoreNames.contains(STORE)) return db
    db.close()
    throw idbError('abrir o banco (sem o depósito da sessão)')
  }

  function openAt (version) {
    return new Promise((resolve, reject) => {
      if (indexedDB === undefined || indexedDB === null) {
        reject(new Error('armazenamento da sessão (IndexedDB) indisponível'))
        return
      }
      let req
      try {
        req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
      } catch (err) {
        reject(idbError('abrir o banco', err))
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        const db = req.result
        // Another tab upgrading or deleting the database: let it.
        db.onversionchange = () => db.close()
        resolve(db)
      }
      req.onerror = () => {
        const err = idbError('abrir o banco', req.error)
        err.idbName = req.error && req.error.name
        reject(err)
      }
      req.onblocked = () => reject(idbError('abrir o banco (bloqueado por outra aba)'))
    })
  }

  // Runs fn(store) in one transaction; resolves with the value of the request
  // fn returns (if any) once the transaction COMMITTED, then closes the db.
  async function transact (mode, what, fn) {
    const db = await openDatabase()
    try {
      return await new Promise((resolve, reject) => {
        let value
        let tx
        try {
          tx = db.transaction([STORE], mode)
          const req = fn(tx.objectStore(STORE))
          if (req) req.onsuccess = () => { value = req.result }
        } catch (err) {
          try { if (tx) tx.abort() } catch {}
          reject(idbError(what, err))
          return
        }
        tx.oncomplete = () => resolve(value)
        tx.onerror = () => reject(idbError(what, tx.error))
        tx.onabort = () => reject(idbError(what, tx.error))
      })
    } finally {
      db.close()
    }
  }

  // prf: the 32-byte PRF output (read, never kept nor changed).
  async function save (prf, { rpId, credentialId, publicKey } = {}) {
    if (!bytesOf(prf, PRF_BYTES)) throw new TypeError('resultado PRF inválido')
    if (!validRpId(rpId)) throw new TypeError('rp.id inválido')
    if (!validCredentialId(credentialId)) throw new TypeError('identificador de passkey inválido')
    if (!validPublicKey(publicKey)) throw new TypeError('chave pública inválida')
    const subtle = crypto.subtle
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = new Uint8Array(IV_BYTES)
    crypto.getRandomValues(iv)
    const plain = new Uint8Array(prf)
    let ciphertext
    try {
      ciphertext = new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: additionalData(rpId, publicKey), tagLength: TAG_BITS },
        key,
        plain
      ))
    } finally {
      plain.fill(0)
    }
    const record = { v: VERSION, rpId, credentialId, publicKey, iv, ciphertext, key, usedAt: clock() }
    await transact('readwrite', 'guardar a sessão', (store) => store.put(record, RECORD_KEY))
  }

  async function clear () {
    await transact('readwrite', 'apagar a sessão', (store) => store.delete(RECORD_KEY))
  }

  async function clearQuietly () {
    try { await clear() } catch {}
  }

  // -> { prf: Uint8Array(32), credentialId } | null. The caller zeroes prf.
  async function load ({ rpId, publicKey } = {}) {
    let record
    try {
      record = await transact('readonly', 'ler a sessão', (store) => store.get(RECORD_KEY))
    } catch {
      await clearQuietly()
      return null
    }
    if (record === undefined) return null
    let out = null
    try {
      out = await open(record, rpId, publicKey)
    } catch {
      out = null
    }
    if (out === null) {
      await clearQuietly()
      return null
    }
    await touch(record, out.at)
    return { prf: out.prf, credentialId: out.credentialId }
  }

  // usedAt = at on the stored record, if it is still the one load() read (a
  // concurrent clear() or save() wins). Best effort: never fails the load.
  async function touch (read, at) {
    try {
      await transact('readwrite', 'renovar a sessão', (store) => {
        const req = store.get(RECORD_KEY)
        req.onsuccess = () => {
          const cur = req.result
          if (cur && typeof cur === 'object' && sameBytes(cur.iv, read.iv) && sameBytes(cur.ciphertext, read.ciphertext)) {
            store.put({ ...cur, usedAt: at }, RECORD_KEY)
          }
        }
        return null
      })
    } catch {}
  }

  async function open (record, rpId, publicKey) {
    if (record === null || typeof record !== 'object') return null
    if (record.v !== VERSION) return null
    if (!validRpId(rpId) || !validPublicKey(publicKey)) return null
    if (record.rpId !== rpId || record.publicKey !== publicKey) return null
    if (!validCredentialId(record.credentialId)) return null
    if (!bytesOf(record.iv, IV_BYTES) || !bytesOf(record.ciphertext, CIPHERTEXT_BYTES)) return null
    if (!isSessionKey(record.key)) return null
    const at = clock()
    const usedAt = record.usedAt
    if (!Number.isSafeInteger(usedAt) || usedAt < 0) return null
    if (at - usedAt > maxIdleMs) return null
    if (usedAt - at > MAX_FUTURE_MS) return null
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: additionalData(rpId, publicKey), tagLength: TAG_BITS },
      record.key,
      record.ciphertext
    ))
    if (plain.byteLength !== PRF_BYTES) {
      plain.fill(0)
      return null
    }
    return { prf: plain, credentialId: record.credentialId, at }
  }

  return { save, load, clear }
}

module.exports = {
  createSessionStore,
  MAX_IDLE_MS,
  MAX_FUTURE_MS,
  STORE,
  RECORD_KEY
}
