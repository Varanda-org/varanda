/* global indexedDB */
// IndexedDB storage for a Hypercore 10 core in the browser, in the same shape
// as ./storage.js: idbStorage(dbName) returns a factory (name) => RandomAccess
// that hypercore 10.38.2 calls once per file ('oplog', 'tree', 'bitfield',
// 'data', 'header').
//
// Contract read from the installed random-access-storage 3.0.2 (index.js):
// subclasses override _open/_read/_write/_del/_truncate/_stat/_close/_unlink,
// each receiving a request and finishing with req.callback(err, value);
// the base class queues blocking ops (open/close/unlink) and refuses every op
// once closed ('Closed'), so a reopen gets a fresh instance from the factory.
// What hypercore 10.38.2 relies on (lib/oplog.js, lib/bitfield.js,
// lib/merkle-tree.js, lib/block-store.js): stat() yields { size }, a read past
// the end fails (merkle-tree.js probes offset 0 and treats an error as an
// empty tree), truncate(offset) sets the length, del(offset, size) clears a
// range and truncates when it reaches the end (as random-access-memory does).
//
// Layout: one database per diary name (dbName), one object store 'files',
// one ArrayBuffer per file name. A file is loaded whole on open, read by
// slicing the in-memory copy and written back whole on every change.
// Spike limit: a multi-MB log rewrites whole files on each write.
// IndexedDB errors are surfaced (in pt-BR); there is never a silent fallback
// to memory.
const RandomAccessStorage = require('random-access-storage')
const b4a = require('b4a')

const STORE = 'files'
const DB_VERSION = 1

function idbError (what, err) {
  const detail = err && err.message ? ': ' + err.message : ''
  return new Error('armazenamento do navegador (IndexedDB) falhou ao ' + what + detail)
}

function openDatabase (dbName) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new Error('armazenamento do navegador (IndexedDB) indisponível'))
      return
    }
    let req
    try {
      req = indexedDB.open(dbName, DB_VERSION)
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
      // Let 'apagar tudo' (deleteDatabase) proceed: drop the connection.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(idbError('abrir o banco', req.error))
    req.onblocked = () => reject(idbError('abrir o banco (bloqueado por outra aba)'))
  })
}

function transact (db, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(STORE, mode)
    } catch (err) {
      reject(err)
      return
    }
    let result
    const req = fn(tx.objectStore(STORE))
    if (req) req.onsuccess = () => { result = req.result }
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error || (req && req.error))
    tx.onabort = () => reject(tx.error || new Error('transação abortada'))
  })
}

class IdbFile extends RandomAccessStorage {
  constructor (dbName, name) {
    super()
    this.dbName = dbName
    this.name = name
    this.db = null
    this.buffer = b4a.alloc(0) // capacity may exceed length
    this.length = 0
  }

  _open (req) {
    openDatabase(this.dbName)
      .then((db) => {
        this.db = db
        return transact(db, 'readonly', (store) => store.get(this.name))
      })
      .then((stored) => {
        if (stored !== undefined) {
          const bytes = new Uint8Array(stored)
          this.buffer = b4a.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          this.length = bytes.byteLength
        }
        req.callback(null)
      })
      .catch((err) => {
        this._closeDb()
        req.callback(err && /IndexedDB/.test(err.message) ? err : idbError('ler ' + this.name, err))
      })
  }

  _stat (req) {
    req.callback(null, { size: this.length })
  }

  _read (req) {
    if (req.offset + req.size > this.length) {
      req.callback(new Error('leitura além do fim do arquivo ' + this.name))
      return
    }
    const out = b4a.alloc(req.size)
    b4a.copy(this.buffer, out, 0, req.offset, req.offset + req.size)
    req.callback(null, out)
  }

  _write (req) {
    const end = req.offset + req.size
    this._ensure(end)
    b4a.copy(req.data, this.buffer, req.offset, 0, req.size)
    if (end > this.length) this.length = end
    this._persist(req)
  }

  _del (req) {
    if (req.offset >= this.length) {
      req.callback(null)
      return
    }
    if (req.offset + req.size >= this.length) {
      this._setLength(req.offset)
    } else {
      this.buffer.fill(0, req.offset, req.offset + req.size)
    }
    this._persist(req)
  }

  _truncate (req) {
    this._setLength(req.offset)
    this._persist(req)
  }

  _close (req) {
    this._closeDb()
    req.callback(null)
  }

  _unlink (req) {
    this.buffer = b4a.alloc(0)
    this.length = 0
    openDatabase(this.dbName)
      .then((db) => transact(db, 'readwrite', (store) => store.delete(this.name)).finally(() => db.close()))
      .then(() => req.callback(null))
      .catch((err) => req.callback(idbError('apagar ' + this.name, err)))
  }

  _setLength (length) {
    if (length > this.length) {
      this._ensure(length)
    } else {
      this.buffer.fill(0, length, this.length)
    }
    this.length = length
  }

  _ensure (size) {
    if (size <= this.buffer.byteLength) return
    const next = b4a.alloc(Math.max(size, this.buffer.byteLength * 2))
    b4a.copy(this.buffer, next, 0, 0, this.length)
    this.buffer = next
  }

  // Writes the whole file back (spike limit, see above). IndexedDB clones the
  // value synchronously in put() and runs readwrite transactions on the same
  // store in creation order, so concurrent writes land in order.
  _persist (req) {
    const copy = this.buffer.buffer.slice(this.buffer.byteOffset, this.buffer.byteOffset + this.length)
    transact(this.db, 'readwrite', (store) => store.put(copy, this.name))
      .then(() => req.callback(null))
      .catch((err) => req.callback(idbError('gravar ' + this.name, err)))
  }

  _closeDb () {
    if (this.db === null) return
    try {
      this.db.close()
    } catch {}
    this.db = null
  }
}

function idbStorage (dbName) {
  if (typeof dbName !== 'string' || dbName.length === 0) throw new TypeError('dbName must be a non-empty string')
  return function createStorage (name) {
    return new IdbFile(dbName, name)
  }
}

// Deletes a whole database (every file of one diary, or the identity store).
function deleteDatabase (dbName) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new Error('armazenamento do navegador (IndexedDB) indisponível'))
      return
    }
    const req = indexedDB.deleteDatabase(dbName)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(idbError('apagar o banco ' + dbName, req.error))
    req.onblocked = () => reject(idbError('apagar o banco ' + dbName + ' (em uso por outra aba)'))
  })
}

module.exports = { idbStorage, deleteDatabase, openDatabase, transact, STORE }
