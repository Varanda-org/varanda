'use strict'
// File-backed node storage for the native worklet (Bare) and Node tests: the
// same interface as lib/node-storage.js (see its header), on random-access-file
// (which maps fs/path to bare-fs/bare-path under Bare; this module does the
// same through the package's #fs and #path imports).
//
// Layout under `dir`:
//   LOCK                          held with an OS-level exclusive lock by lock()
//   cores/<hex(utf8 name)>/<file> one random-access-file per hypercore file
//   kv/<hex(utf8 key)>.json       the JSON key-value area (atomic, durable replace)
// random-access-file reads and writes on demand, so a large data file is
// never loaded whole; core() ignores `lazy` and `cachePages` for that reason.
const RandomAccessFile = require('random-access-file')
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')

const FILES = ['oplog', 'tree', 'bitfield', 'data', 'header']

function hexName (name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('storage name must be a non-empty string')
  return b4a.toString(b4a.from(name, 'utf8'), 'hex')
}

function call (fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, res) => err ? reject(err) : resolve(res))
  })
}

function closeFile (raf) {
  return new Promise((resolve) => raf.close(() => resolve()))
}

// A directory fsync is not offered everywhere (Windows refuses to open or
// sync one): only these codes of the directory step are ignored.
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'])

function dirSyncUnsupported (err) {
  return err !== null && typeof err === 'object' && DIR_SYNC_UNSUPPORTED.has(err.code)
}

async function writeFully (fd, data) {
  let at = 0
  while (at < data.byteLength) {
    const n = await call(fs.write, fd, data, at, data.byteLength - at, at)
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('short write')
    at += n
  }
}

// tmp is on disk before it replaces file, so a crash right after the rename
// never leaves an empty or partial value under the key.
async function writeSynced (tmp, data) {
  const fd = await call(fs.open, tmp, 'w')
  try {
    await writeFully(fd, data)
    await call(fs.fsync, fd)
  } catch (err) {
    await call(fs.close, fd).catch(() => {})
    throw err
  }
  await call(fs.close, fd)
}

// Makes the rename itself durable (the directory entry).
async function syncDir (dir) {
  let fd
  try {
    fd = await call(fs.open, dir, 'r')
  } catch (err) {
    if (dirSyncUnsupported(err)) return
    throw err
  }
  try {
    await call(fs.fsync, fd)
  } catch (err) {
    if (!dirSyncUnsupported(err)) {
      await call(fs.close, fd).catch(() => {})
      throw err
    }
  }
  await call(fs.close, fd)
}

async function fileSize (file) {
  try {
    return (await call(fs.stat, file)).size
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0
    throw err
  }
}

function fileNodeStorage (dir) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('dir required')
  const coresDir = path.join(dir, 'cores')
  const kvDir = path.join(dir, 'kv')
  let files = new Set() // open random-access-file instances, closed by close()
  const writes = new Map() // kv file -> the last queued write of it
  let lockFile = null

  function coreDir (name) {
    return path.join(coresDir, hexName(name))
  }

  function kvFile (key) {
    return path.join(kvDir, hexName(key) + '.json')
  }

  return {
    core (name) {
      const base = coreDir(name)
      // Every call to the factory opens a fresh file on the same path, so a
      // factory used again after close() works (the rule of lib/storage.js).
      return (file) => {
        const raf = new RandomAccessFile(path.join(base, file))
        // Cores are closed and reopened all session long: a closed file
        // leaves the set so it is not kept until close().
        const open = files
        open.add(raf)
        raf.once('close', () => open.delete(raf))
        return raf
      }
    },
    async hasCore (name) {
      const base = coreDir(name)
      for (const file of FILES) {
        if (await fileSize(path.join(base, file)) > 0) return true
      }
      return false
    },
    async deleteCore (name) {
      await call(fs.rm, coreDir(name), { recursive: true, force: true })
    },
    async readJson (key) {
      let text
      try {
        text = await call(fs.readFile, kvFile(key), 'utf8')
      } catch (err) {
        if (err && err.code === 'ENOENT') return null
        throw err
      }
      return JSON.parse(text)
    },
    // Writes of one key run one after another: they share the .tmp path, and
    // an overlapping pair would rename each other's bytes into place. A
    // resolved write survives a crash (the native sign-out marker relies on
    // it): the tmp file is fsynced before the rename and the directory after.
    writeJson (key, value) {
      const file = kvFile(key)
      const text = JSON.stringify(value)
      const prev = writes.get(file) || Promise.resolve()
      const next = prev.catch(() => {}).then(async () => {
        const tmp = file + '.tmp'
        await call(fs.mkdir, kvDir, { recursive: true })
        await writeSynced(tmp, b4a.from(text, 'utf8'))
        await call(fs.rename, tmp, file)
        await syncDir(kvDir)
      })
      writes.set(file, next)
      const forget = () => { if (writes.get(file) === next) writes.delete(file) }
      next.then(forget, forget)
      return next
    },
    // Fails closed: random-access-file silently skips the lock when
    // fs-native-extensions is missing, and two Hypercore instances on the
    // same files corrupt each other.
    async lock () {
      if (lockFile) return
      let ext = null
      try {
        ext = require('fs-native-extensions')
      } catch {}
      if (!ext || typeof ext.tryLock !== 'function') {
        const err = new Error('trava do diretório indisponível')
        err.code = 'LOCK_UNAVAILABLE'
        throw err
      }
      await call(fs.mkdir, dir, { recursive: true })
      const raf = new RandomAccessFile(path.join(dir, 'LOCK'), { lock: true, truncate: true }) // truncate makes it create the file; it runs after the lock
      try {
        await new Promise((resolve, reject) => raf.open((err) => err ? reject(err) : resolve()))
      } catch (cause) {
        await closeFile(raf)
        if (cause && cause.code === 'ELOCKED') {
          const err = new Error('diretório de dados em uso')
          err.code = 'LOCKED'
          throw err
        }
        throw cause
      }
      lockFile = raf
    },
    async close () {
      const open = files
      files = new Set()
      await Promise.all([...open].map(closeFile))
      if (lockFile) {
        const raf = lockFile
        lockFile = null
        await closeFile(raf)
      }
    }
  }
}

module.exports = { fileNodeStorage }
