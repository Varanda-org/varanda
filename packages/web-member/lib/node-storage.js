/* global indexedDB, IDBKeyRange */
// Storage of the browser node: every Hypercore 10 core it holds (the own
// diary, 'diary', and one replica per followed diary, 'replica/<hex>') and
// a small JSON key-value area (the trust root 'config' and 'follows'), behind
// one interface that the session code uses in a browser (IndexedDB) and in
// Node tests (memory):
//
//   storage.core(name, opts) -> the factory (file) => RandomAccessStorage that
//                               hypercore 10.38.2 calls once per file
//                               ('oplog', 'tree', 'bitfield', 'data', 'header');
//                               opts.lazy = file names opened in lazy mode
//                               (below), opts.cachePages = its cache size
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
//
// Lazy mode (core(name, { lazy: ['data'] }); a media core's 'data' file can
// reach 256 MiB, so loading it whole is out of the question): the file's
// length comes from 'files' when it opens and pages are loaded from 'pages'
// on demand into an LRU cache of `cachePages` decoded pages (default 64).
// random-access-storage 3.0.2 runs read/write/del/truncate/stat concurrently
// once a file is open, so the lazy file keeps these invariants:
//   - one cache entry per page: concurrent loads of a page share one promise;
//   - every operation on a page waits for the operations issued before it on
//     that page to apply their in-memory change (a per-page chain), so the
//     outcome is the one of applying the operations in issue order;
//   - the length changes synchronously when an operation is issued (as in
//     whole-file mode), and so does a truncate's or del's dropping of the
//     pages it removes whole (the IndexedDB delete is issued at once, so a
//     later load of such a page sees zeros; an earlier operation still in
//     flight on a dropped page applies its change to the dropped page in
//     memory, so the reads issued between the two still see it, but never
//     persists it, which would resurrect the page);
//   - a page is never evicted while an operation is using it (pinned), while
//     it is loading or while a persist of it is in flight; so the cache may
//     exceed `cachePages` by the pages in use and is back under it when idle;
//   - a persist clones the page at put time (as in whole-file mode); a load
//     failure or a persist failure fails that operation (fail closed), and
//     an operation answers only once EVERY part of its work has settled, so
//     a failed part never leaves another part running past the answer;
//   - close waits for every operation and persist in flight and refuses any
//     persist after it, so nothing of the file is written after close (and
//     deleteCore, which as in whole-file mode needs the core closed first,
//     finds nothing still writing).
// The memory twin accepts core(name, { lazy }) and ignores it.
const RandomAccessStorage = require('random-access-storage')
const b4a = require('b4a')
const { memoryStorage } = require('./storage')

const DB_VERSION = 1
const PAGE_SIZE = 16384
const DEFAULT_CACHE_PAGES = 64
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

function fileRange (core, file, from = 0, to = Infinity) {
  return IDBKeyRange.bound([core, file, from], [core, file, to])
}

// The page segments [offset, offset + size): { index, start (in the page),
// n (bytes), done (offset in the operation's data) }.
function segments (offset, size) {
  const out = []
  let done = 0
  while (done < size) {
    const at = offset + done
    const index = Math.floor(at / PAGE_SIZE)
    const start = at - index * PAGE_SIZE
    const n = Math.min(PAGE_SIZE - start, size - done)
    out.push({ index, start, n, done })
    done += n
  }
  return out
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

// One file of one core in lazy mode (see the header). `cache` maps a page
// index to an entry { index, page (PAGE_SIZE Uint8Array, null while
// loading), chain (the promise of the last operation issued on the page),
// pins, persisting, dropped, error }, in LRU order (oldest first).
class LazyPagedFile extends RandomAccessStorage {
  constructor (owner, core, file, cachePages) {
    super()
    this.owner = owner
    this.core = core
    this.file = file
    this.cachePages = cachePages
    this.cache = new Map()
    this.length = 0
    this.inflight = new Set() // every operation's work (loads, changes, persists)
    this.persists = new Set()
    this.closing = false
  }

  _open (req) {
    transact(this.owner.db, [FILES], 'readonly', (s) => request(s[FILES].get([this.core, this.file])))
      .then((length) => {
        this.length = typeof length === 'number' ? length : 0
        this.closing = false
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
    const segs = segments(req.offset, req.size)
    const out = b4a.alloc(req.size)
    const op = this._onPages(segs.map((s) => s.index), (entries) => {
      segs.forEach((s, i) => out.set(entries[i].page.subarray(s.start, s.start + s.n), s.done))
      return out
    })
    this._finish(req, [op.done.finally(op.release)])
  }

  _write (req) {
    const end = req.offset + req.size
    if (end > this.length) this.length = end
    const segs = segments(req.offset, req.size)
    const op = this._onPages(segs.map((s) => s.index), (entries) => {
      const dirty = []
      segs.forEach((s, i) => {
        const e = entries[i]
        e.page.set(req.data.subarray(s.done, s.done + s.n), s.start)
        if (!e.dropped) dirty.push(e)
      })
      return { persist: this._persist(dirty, null) }
    })
    this._finish(req, [op.done.then((r) => r.persist).finally(op.release)])
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
    const pending = []
    const partial = []
    let from = -1
    let to = -1
    for (const s of segments(req.offset, req.size)) {
      if (s.start === 0 && s.n === PAGE_SIZE) {
        if (from === -1) from = s.index
        to = s.index
      } else {
        partial.push(s)
      }
    }
    if (from !== -1) {
      for (const e of [...this.cache.values()]) if (e.index >= from && e.index <= to) this._drop(e)
      pending.push(this._persist([], fileRange(this.core, this.file, from, to)))
    }
    if (partial.length > 0) {
      const op = this._onPages(partial.map((s) => s.index), (entries) => {
        const dirty = []
        partial.forEach((s, i) => {
          const e = entries[i]
          e.page.fill(0, s.start, s.start + s.n)
          if (!e.dropped) dirty.push(e)
        })
        return { persist: this._persist(dirty, null) }
      })
      pending.push(op.done.then((r) => r.persist).finally(op.release))
    }
    this._finish(req, pending)
  }

  _truncate (req) {
    const length = req.offset
    const pending = []
    if (length < this.length) {
      const keep = Math.ceil(length / PAGE_SIZE) // pages [0, keep) stay
      for (const e of [...this.cache.values()]) if (e.index >= keep) this._drop(e)
      this.length = length
      pending.push(this._persist([], fileRange(this.core, this.file, keep)))
      const tail = length % PAGE_SIZE
      if (tail !== 0) {
        const op = this._onPages([keep - 1], ([e]) => {
          e.page.fill(0, tail)
          return { persist: e.dropped ? null : this._persist([e], null) }
        })
        pending.push(op.done.then((r) => r.persist).finally(op.release))
      }
    } else {
      this.length = length
      pending.push(this._persist([], null))
    }
    this._finish(req, pending)
  }

  // Answers req once EVERY part of its work (loads, in-memory changes and
  // persists, `pending`) has settled, with the first failure if any: a part
  // that fails early never leaves another part running past the callback,
  // past close or past deleteCore.
  _finish (req, pending) {
    const all = Promise.allSettled(pending).then((results) => {
      this.inflight.delete(all)
      const failed = results.find((r) => r.status === 'rejected')
      if (failed) throw failed.reason
      return results.length === 1 ? results[0].value : undefined
    })
    this.inflight.add(all)
    all.then((value) => req.callback(null, value), (err) => req.callback(err))
  }

  // Waits for every operation still in flight and every persist, then
  // refuses any later persist (none is expected: random-access-storage runs
  // close only once every operation has answered).
  _close (req) {
    this.closing = true
    Promise.allSettled([...this.inflight, ...this.persists]).then(() => {
      this.cache.clear()
      req.callback(null)
    })
  }

  _unlink (req) {
    this.cache.clear()
    this.length = 0
    transact(this.owner.db, [PAGES, FILES], 'readwrite', (s) => {
      s[PAGES].delete(fileRange(this.core, this.file))
      s[FILES].delete([this.core, this.file])
    }).then(() => req.callback(null), (err) => req.callback(idbError('apagar ' + this.file, err)))
  }

  // The cache entry of page `index`, pinned; a missing page starts loading
  // (its chain is the load) and a cached one moves to the LRU's newest end.
  _acquire (index) {
    let e = this.cache.get(index)
    if (e) {
      this.cache.delete(index)
    } else {
      e = { index, page: null, chain: null, pins: 0, persisting: 0, dropped: false, error: null }
      e.chain = transact(this.owner.db, [PAGES], 'readonly', (s) => request(s[PAGES].get([this.core, this.file, index])))
        .then((value) => {
          const page = new Uint8Array(PAGE_SIZE)
          if (value) page.set(new Uint8Array(value).subarray(0, PAGE_SIZE))
          e.page = page
        }, (err) => {
          e.error = idbError('ler ' + this.file, err)
          this._drop(e)
          throw e.error
        })
    }
    this.cache.set(index, e)
    e.pins++
    return e
  }

  // Runs fn(entries) (synchronously) once every page of `indices` is loaded
  // and every operation issued before this one on those pages has applied
  // its in-memory change; `done` is fn's value (or its error, or the load
  // error). The pages stay pinned until release().
  _onPages (indices, fn) {
    const entries = indices.map((index) => this._acquire(index))
    this._evict()
    const prior = entries.map((e) => e.chain)
    let settle
    const chain = new Promise((resolve) => { settle = resolve })
    for (const e of entries) e.chain = chain
    const done = Promise.all(prior).then(() => {
      for (const e of entries) if (e.error) throw e.error
      return fn(entries)
    })
    done.then(settle, settle)
    return {
      done,
      release: () => {
        for (const e of entries) e.pins--
        this._evict()
      }
    }
  }

  _drop (e) {
    e.dropped = true
    if (this.cache.get(e.index) === e) this.cache.delete(e.index)
  }

  _evict () {
    for (const [index, e] of this.cache) {
      if (this.cache.size <= this.cachePages) return
      if (e.pins === 0 && e.persisting === 0 && e.page !== null) this.cache.delete(index)
    }
  }

  // put() clones each page synchronously, so later in-memory changes never
  // leak into this transaction. `removed`: a key range of pages to delete.
  _persist (dirty, removed) {
    if (this.closing) return Promise.reject(new Error('arquivo ' + this.file + ' fechado: gravação recusada'))
    for (const e of dirty) e.persisting++
    const tx = transact(this.owner.db, [PAGES, FILES], 'readwrite', (s) => {
      for (const e of dirty) s[PAGES].put(e.page, [this.core, this.file, e.index])
      if (removed) s[PAGES].delete(removed)
      s[FILES].put(this.length, [this.core, this.file])
    })
    this.persists.add(tx)
    return tx.then(() => null, (err) => idbError('gravar ' + this.file, err)).then((err) => {
      this.persists.delete(tx)
      for (const e of dirty) e.persisting--
      this._evict()
      if (err) throw err
    })
  }
}

function coreOptions (opts) {
  if (opts === undefined || opts === null) return { lazy: new Set(), cachePages: DEFAULT_CACHE_PAGES }
  if (typeof opts !== 'object') throw new TypeError('core options must be an object')
  const lazy = opts.lazy === undefined ? [] : opts.lazy
  if (!Array.isArray(lazy) || !lazy.every((f) => typeof f === 'string')) throw new TypeError('lazy must be an array of file names')
  const cachePages = opts.cachePages === undefined ? DEFAULT_CACHE_PAGES : opts.cachePages
  if (!Number.isInteger(cachePages) || cachePages < 1) throw new TypeError('cachePages must be a positive integer')
  return { lazy: new Set(lazy), cachePages }
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
    core (name, opts) {
      checkName(name)
      const { lazy, cachePages } = coreOptions(opts)
      return (file) => (lazy.has(file)
        ? new LazyPagedFile(owner, name, file, cachePages)
        : new PagedFile(owner, name, file))
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
    core (name, opts) {
      checkName(name)
      coreOptions(opts) // accepted and ignored: memory files are never large
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

module.exports = { idbNodeStorage, memoryNodeStorage, PAGE_SIZE, DB_VERSION, DEFAULT_CACHE_PAGES }
