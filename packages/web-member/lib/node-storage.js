/* global indexedDB, IDBKeyRange */
// Storage of the browser node: every Hypercore 10 core it holds (the own
// diary, 'diary', and one replica per followed diary, 'replica/<hex>') and
// a small JSON key-value area (the trust root 'config' and 'follows'), behind
// one interface that the session code uses in a browser (IndexedDB) and in
// Node tests (memory):
//
//   storage.core(name)       -> the factory (file) => RandomAccessStorage that
//                               hypercore 10.38.2 calls once per file
//                               ('oplog', 'tree', 'bitfield', 'data', 'header')
//   storage.hasCore(name)    -> Promise<boolean>: some file of the core holds bytes
//   storage.deleteCore(name) -> Promise: every file of the core is gone (the core
//                               must be closed first)
//   storage.readJson(key)    -> Promise<value | null>
//   storage.writeJson(key, value) -> Promise
//   storage.close()          -> Promise
//
// IndexedDB layout (one database per origin, DB_VERSION 1): object store
// 'pages' holds each file in PAGE_SIZE pages keyed [core, file, index],
// 'files' holds each file's length keyed [core, file], and 'kv' holds JSON
// text keyed by name. A file is loaded whole when it opens; a write persists
// only the pages it touched (one readwrite transaction per operation, which
// IndexedDB runs in creation order), so appending to a long diary costs one
// page, not the whole file (the spike adapter, ./idb-storage.js, rewrote
// whole files). IndexedDB errors surface in pt-BR; there is never a silent
// fallback to memory.
const RandomAccessStorage = require('random-access-storage')
const b4a = require('b4a')
const { memoryStorage } = require('./storage')

const DB_VERSION = 1
const PAGE_SIZE = 16384
const PAGES = 'pages'
const FILES = 'files'
const KV = 'kv'

function idbError (what, err) {
  const detail = err && typeof err.name === 'string' ? ' (' + err.name + ')' : ''
  return new Error('armazenamento do navegador (IndexedDB) falhou ao ' + what + detail)
}

function request (req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Runs fn(stores) in one transaction over `names`; resolves with fn's value
// once the transaction COMMITTED (oncomplete), so a resolved write is durable.
// fn is called synchronously and issues every request before its first
// await (a transaction commits once no request is pending).
function transact (db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx
    let out
    try {
      tx = db.transaction(names, mode)
      const stores = {}
      for (const name of names) stores[name] = tx.objectStore(name)
      out = fn(stores)
    } catch (err) {
      try { if (tx) tx.abort() } catch {}
      reject(err)
      return
    }
    let value
    Promise.resolve(out).then((v) => { value = v }, (err) => {
      try { tx.abort() } catch {}
      reject(err)
    })
    tx.oncomplete = () => resolve(value)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transação abortada'))
  })
}

// Every key of one core: [core] < [core, file, ...] < [core, []] (arrays sort
// after strings in IndexedDB key order).
function coreRange (core) {
  return IDBKeyRange.bound([core], [core, []])
}

function fileRange (core, file) {
  return IDBKeyRange.bound([core, file, 0], [core, file, Infinity])
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
      for (const name of [PAGES, FILES, KV]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(idbError('abrir o banco', req.error))
    req.onblocked = () => reject(idbError('abrir o banco (bloqueado por outra aba)'))
  })
}

// One file of one core, paged. `pages` maps a page index to a PAGE_SIZE
// Uint8Array; a missing page reads as zeros.
class PagedFile extends RandomAccessStorage {
  constructor (owner, core, file) {
    super()
    this.owner = owner
    this.core = core
    this.file = file
    this.pages = new Map()
    this.length = 0
  }

  _open (req) {
    const db = this.owner.db
    transact(db, [PAGES, FILES], 'readonly', (s) => Promise.all([
      request(s[FILES].get([this.core, this.file])),
      request(s[PAGES].getAllKeys(fileRange(this.core, this.file))),
      request(s[PAGES].getAll(fileRange(this.core, this.file)))
    ])).then(([length, keys, values]) => {
      this.length = typeof length === 'number' ? length : 0
      for (let i = 0; i < keys.length; i++) {
        const page = new Uint8Array(PAGE_SIZE)
        page.set(new Uint8Array(values[i]).subarray(0, PAGE_SIZE))
        this.pages.set(keys[i][2], page)
      }
      req.callback(null)
    }, (err) => req.callback(idbError('ler ' + this.file, err)))
  }

  _stat (req) {
    req.callback(null, { size: this.length })
  }

  _read (req) {
    if (req.offset + req.size > this.length) {
      req.callback(new Error('leitura além do fim do arquivo ' + this.file))
      return
    }
    const out = b4a.alloc(req.size)
    let done = 0
    while (done < req.size) {
      const at = req.offset + done
      const index = Math.floor(at / PAGE_SIZE)
      const start = at - index * PAGE_SIZE
      const n = Math.min(PAGE_SIZE - start, req.size - done)
      const page = this.pages.get(index)
      if (page) out.set(page.subarray(start, start + n), done)
      done += n
    }
    req.callback(null, out)
  }

  _write (req) {
    const dirty = new Set()
    let done = 0
    while (done < req.size) {
      const at = req.offset + done
      const index = Math.floor(at / PAGE_SIZE)
      const start = at - index * PAGE_SIZE
      const n = Math.min(PAGE_SIZE - start, req.size - done)
      this._page(index).set(req.data.subarray(done, done + n), start)
      dirty.add(index)
      done += n
    }
    const end = req.offset + req.size
    if (end > this.length) this.length = end
    this._persist(req, dirty, [])
  }

  _del (req) {
    if (req.offset >= this.length) {
      req.callback(null)
      return
    }
    // A delete that reaches the end truncates, as random-access-memory does.
    if (req.offset + req.size >= this.length) {
      this._truncate(req)
      return
    }
    const dirty = new Set()
    const end = req.offset + req.size
    for (let at = req.offset; at < end;) {
      const index = Math.floor(at / PAGE_SIZE)
      const start = at - index * PAGE_SIZE
      const n = Math.min(PAGE_SIZE - start, end - at)
      const page = this.pages.get(index)
      if (page) {
        page.fill(0, start, start + n)
        dirty.add(index)
      }
      at += n
    }
    this._persist(req, dirty, [])
  }

  _truncate (req) {
    const length = req.offset
    const dirty = new Set()
    const removed = []
    if (length < this.length) {
      const keep = Math.ceil(length / PAGE_SIZE) // pages [0, keep) stay
      for (const index of [...this.pages.keys()]) {
        if (index >= keep) {
          this.pages.delete(index)
          removed.push(index)
        }
      }
      const tail = length % PAGE_SIZE
      const last = this.pages.get(keep - 1)
      if (tail !== 0 && last) {
        last.fill(0, tail)
        dirty.add(keep - 1)
      }
    }
    this.length = length
    this._persist(req, dirty, removed)
  }

  _close (req) {
    req.callback(null)
  }

  _unlink (req) {
    this.pages.clear()
    this.length = 0
    transact(this.owner.db, [PAGES, FILES], 'readwrite', (s) => {
      s[PAGES].delete(fileRange(this.core, this.file))
      s[FILES].delete([this.core, this.file])
    }).then(() => req.callback(null), (err) => req.callback(idbError('apagar ' + this.file, err)))
  }

  _page (index) {
    let page = this.pages.get(index)
    if (!page) {
      page = new Uint8Array(PAGE_SIZE)
      this.pages.set(index, page)
    }
    return page
  }

  // put() clones each page synchronously, so later in-memory changes never
  // leak into this transaction.
  _persist (req, dirty, removed) {
    transact(this.owner.db, [PAGES, FILES], 'readwrite', (s) => {
      for (const index of dirty) s[PAGES].put(this.pages.get(index), [this.core, this.file, index])
      for (const index of removed) s[PAGES].delete([this.core, this.file, index])
      s[FILES].put(this.length, [this.core, this.file])
    }).then(() => req.callback(null), (err) => req.callback(idbError('gravar ' + this.file, err)))
  }
}

// -> Promise<storage> over the IndexedDB database `dbName` (one connection,
// shared by every file).
async function idbNodeStorage (dbName) {
  if (typeof dbName !== 'string' || dbName.length === 0) throw new TypeError('dbName must be a non-empty string')
  const db = await openDatabase(dbName)
  const owner = { db }
  // Another tab deleting or upgrading the database: let it (this connection
  // fails from here on, and every later operation reports the IndexedDB error).
  db.onversionchange = () => db.close()
  let closed = false

  return {
    core (name) {
      checkName(name)
      return (file) => new PagedFile(owner, name, file)
    },
    async hasCore (name) {
      checkName(name)
      const lengths = await transact(db, [FILES], 'readonly', (s) => request(s[FILES].getAll(coreRange(name))))
        .catch((err) => { throw idbError('ler ' + name, err) })
      return lengths.some((n) => n > 0)
    },
    async deleteCore (name) {
      checkName(name)
      await transact(db, [PAGES, FILES], 'readwrite', (s) => {
        s[PAGES].delete(coreRange(name))
        s[FILES].delete(coreRange(name))
      }).catch((err) => { throw idbError('apagar ' + name, err) })
    },
    async readJson (key) {
      const text = await transact(db, [KV], 'readonly', (s) => request(s[KV].get(key)))
        .catch((err) => { throw idbError('ler ' + key, err) })
      return typeof text === 'string' ? JSON.parse(text) : null
    },
    async writeJson (key, value) {
      const text = JSON.stringify(value)
      await transact(db, [KV], 'readwrite', (s) => { s[KV].put(text, key) })
        .catch((err) => { throw idbError('gravar ' + key, err) })
    },
    async close () {
      if (closed) return
      closed = true
      try { db.close() } catch {}
    }
  }
}

// The same interface in memory (tests, and nothing else): each core is a
// ./storage.js memoryStorage factory, so a reopen sees the same files.
function memoryNodeStorage () {
  const cores = new Map() // name -> { factory, files: Map(file -> RAM) }
  const kv = new Map()

  function entry (name) {
    let e = cores.get(name)
    if (!e) {
      const files = new Map()
      const factory = memoryStorage()
      e = {
        files,
        factory: (file) => {
          const ram = factory(file)
          files.set(file, ram)
          return ram
        }
      }
      cores.set(name, e)
    }
    return e
  }

  return {
    core (name) {
      checkName(name)
      return entry(name).factory
    },
    async hasCore (name) {
      checkName(name)
      const e = cores.get(name)
      if (!e) return false
      for (const ram of e.files.values()) if (ram.length > 0) return true
      return false
    },
    async deleteCore (name) {
      checkName(name)
      cores.delete(name)
    },
    async readJson (key) {
      return kv.has(key) ? JSON.parse(kv.get(key)) : null
    },
    async writeJson (key, value) {
      kv.set(key, JSON.stringify(value))
    },
    async close () {}
  }
}

function checkName (name) {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('core name must be a non-empty string')
}

module.exports = { idbNodeStorage, memoryNodeStorage, PAGE_SIZE, DB_VERSION }
