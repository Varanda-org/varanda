// IndexedDB backend for ./peekPhotoStore.js. IndexedDB, not the Cache API:
// the browser node already requires IndexedDB, the Cache API is optional in
// this app, the service worker owns the Cache Storage namespace, and one
// transaction keeps a row and its bytes, or a clear of all three stores,
// together. Without IndexedDB, or when the open fails, every method answers
// empty or false and the store stays off. Each store has its own database
// (createBackend's name), so a clear of one never touches another.
//
// keptPhotos holds the own and followed authors' photos (the main kinds), with
// the caps of ./keep.native.js's main pool: the web fetches every photo with
// no-store (./keptLoad.js fetchPersist), since nothing can erase the browser
// HTTP cache on lock, Sair, reset or an account change.

import {
  COPY_PHOTO_KINDS,
  COPY_PHOTO_MAX_AGE_MS,
  COPY_PHOTO_MAX_BYTES,
  COPY_PHOTO_MAX_FILES,
  createPeekPhotoStore
} from './peekPhotoStore.js'

const DB_NAME = 'varanda-peek-photos'
const COPY_DB_NAME = 'varanda-copy-photos'
const KEPT_DB_NAME = 'varanda-kept-photos'
const DB_VERSION = 1
const META = 'meta'
const BYTES = 'bytes'
const BINDING = 'binding'
const BINDING_KEY = 'current'

const request = (req, set) => { req.onsuccess = () => set(req.result) }

function sameBinding (a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  return typeof a.origin === 'string' && a.origin === b.origin &&
    typeof a.association === 'string' && a.association === b.association &&
    typeof a.owner === 'string' && a.owner === b.owner
}

export function createBackend (name = DB_NAME) {
  let opening = null

  function open () {
    if (opening !== null) return opening
    opening = new Promise((resolve) => {
      const idb = globalThis.indexedDB
      if (!idb || typeof idb.open !== 'function') return resolve(null)
      let req
      try { req = idb.open(name, DB_VERSION) } catch { return resolve(null) }
      req.onupgradeneeded = (event) => {
        try {
          const db = req.result
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'name' })
          if (!db.objectStoreNames.contains(BYTES)) db.createObjectStore(BYTES)
          if (!db.objectStoreNames.contains(BINDING)) db.createObjectStore(BINDING)
        } catch {
          // Committing version 1 with a store missing would skip the upgrade on
          // every later open; aborting fails this open and the next load retries.
          try { event.target.transaction.abort() } catch {}
        }
      }
      req.onsuccess = () => {
        const db = req.result
        if (![META, BYTES, BINDING].every((name) => db.objectStoreNames.contains(name))) {
          try { db.close() } catch {}
          return resolve(null)
        }
        // Another tab upgrading or deleting the database must not wait on this
        // one; the next call opens it again.
        db.onversionchange = () => {
          try { db.close() } catch {}
          opening = null
        }
        db.onclose = () => { opening = null }
        resolve(db)
      }
      req.onerror = () => resolve(null)
    })
    return opening
  }

  // Runs fn inside one transaction; resolves with fn's result once the
  // transaction completes, rejects when it fails or aborts.
  async function inTx (names, mode, fn) {
    const db = await open()
    if (db === null) return { off: true }
    return new Promise((resolve, reject) => {
      let out
      const tx = db.transaction(names, mode)
      tx.oncomplete = () => resolve({ value: out })
      tx.onerror = () => reject(tx.error || new Error('idb'))
      tx.onabort = () => reject(tx.error || new Error('idb abort'))
      try {
        fn(tx, (v) => { out = v })
      } catch (err) {
        try { tx.abort() } catch {}
        reject(err)
      }
    })
  }

  return {
    async getBinding () {
      const r = await inTx([BINDING], 'readonly', (tx, set) => request(tx.objectStore(BINDING).get(BINDING_KEY), set))
      return r.off ? null : (r.value ?? null)
    },
    async setBinding (binding) {
      const r = await inTx([BINDING], 'readwrite', (tx) => { tx.objectStore(BINDING).put(binding, BINDING_KEY) })
      return !r.off
    },
    async list () {
      const r = await inTx([META], 'readonly', (tx, set) => request(tx.objectStore(META).getAll(), set))
      return r.off || !Array.isArray(r.value) ? [] : r.value
    },
    // Reads only while the stored binding is still the caller's: another tab
    // may have rebound the store to another account since this tab's bind.
    // false then, so the caller leaves that account's entry alone.
    async get (name, binding) {
      const r = await inTx([BYTES, BINDING], 'readonly', (tx, set) => {
        const req = tx.objectStore(BINDING).get(BINDING_KEY)
        req.onsuccess = () => {
          if (!sameBinding(req.result, binding)) return set(false)
          request(tx.objectStore(BYTES).get(name), set)
        }
      })
      if (r.off) return null
      if (r.value === false) return false
      return r.value instanceof ArrayBuffer ? new Uint8Array(r.value) : null
    },
    // Writes only while the stored binding is still the one the caller bound
    // to: another tab may have wiped or rebound the store in the meantime.
    async put (row, bytes, binding) {
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const r = await inTx([META, BYTES, BINDING], 'readwrite', (tx, set) => {
        const req = tx.objectStore(BINDING).get(BINDING_KEY)
        req.onsuccess = () => {
          if (!sameBinding(req.result, binding)) return set(false)
          tx.objectStore(META).put(row)
          tx.objectStore(BYTES).put(buf, row.name)
          set(true)
        }
      })
      return !r.off && r.value === true
    },
    async remove (names) {
      const r = await inTx([META, BYTES], 'readwrite', (tx) => {
        const meta = tx.objectStore(META)
        const bytes = tx.objectStore(BYTES)
        for (const name of names) {
          meta.delete(name)
          bytes.delete(name)
        }
      })
      return !r.off
    },
    async clear () {
      const r = await inTx([META, BYTES, BINDING], 'readwrite', (tx) => {
        tx.objectStore(META).clear()
        tx.objectStore(BYTES).clear()
        tx.objectStore(BINDING).clear()
      })
      return !r.off
    }
  }
}

export const backend = createBackend()
export const copyBackend = createBackend(COPY_DB_NAME)
export const keptBackend = createBackend(KEPT_DB_NAME)

export const KEPT_PHOTO_KINDS = Object.freeze(['avatars', 'posts'])
export const KEPT_PHOTO_MAX_BYTES = 67108864
export const KEPT_PHOTO_MAX_FILES = 2000
export const KEPT_PHOTO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export const peekPhotos = createPeekPhotoStore({ backend })
export const copyPhotos = createPeekPhotoStore({
  backend: copyBackend,
  kinds: COPY_PHOTO_KINDS,
  maxBytes: COPY_PHOTO_MAX_BYTES,
  maxFiles: COPY_PHOTO_MAX_FILES,
  maxAgeMs: COPY_PHOTO_MAX_AGE_MS
})
export const keptPhotos = createPeekPhotoStore({
  backend: keptBackend,
  kinds: KEPT_PHOTO_KINDS,
  maxBytes: KEPT_PHOTO_MAX_BYTES,
  maxFiles: KEPT_PHOTO_MAX_FILES,
  maxAgeMs: KEPT_PHOTO_MAX_AGE_MS
})
