'use strict'

// The encrypted "seen" blob the account service keeps for each member, so
// every device of the same passkey shows the same read marks. One raw file
// per member, <dataDir>/seen/<member hex64> (mode 0o600, directory 0o700),
// holding exactly SEEN_BLOB_BYTES of ciphertext and nothing else: no JSON,
// no version counter, no timestamp. The operator learns that a member has a
// blob, its constant size and its mtime, never what it marks.
//
// The compare-and-swap revision is blobHash() of the current bytes (HASH_NONE
// when there is no file), so the store keeps no state of its own and older
// and newer builds read the same directory. One current file per member: no
// history and no retention sweep.
//
// A member file this module would not have written (any other length, a
// directory, a symlink, a FIFO) makes only that member 'indisponivel' and is
// never rewritten or removed; the other members keep working. A bad seen
// directory (a symlink or not a directory) makes the whole store unavailable
// until heal() finds it fixed. fail() (the lock is lost) is for good.
//
// Every mutation runs in one in-process queue, re-reads the file, and asks
// guard() before it touches anything and again after the rename: the service
// lock goes stale after 30 s, so a holder that lost it meanwhile does not
// acknowledge (the terms-store.js discipline). Its remaining window applies
// here too, without OS file locks: a stalled rename can land after a
// takeover and replace a blob the new holder already acknowledged. Unlike
// terms-store, this store keeps nothing in memory to write it back. The
// marks are not lost for good: every device keeps its own marks locally and
// the merge is a union, so the device whose write was replaced finds its
// marks missing from the blob on its next pass and writes them again. The
// same window lets a stalled forget remove a blob the new holder just wrote
// (the devices write it again) or a stalled write bring back one it just
// removed; no client of this version asks for a delete.
// guard() === false refuses that call only.
//
// Logs carry only { event: 'seen', reason }: never a member, a hash or a byte.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { blobHash, HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { SEEN_BLOB_BYTES } = require('@varanda/core/lib/seen-blob')

const DIR = 'seen'
const MAX_MEMBERS = 100000
const HEX64_RE = /^[0-9a-f]{64}$/
const FSYNC_DIR_IGNORED = new Set(['EISDIR', 'EPERM', 'EINVAL'])

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function noop () {}

function checkMember (member) {
  if (typeof member !== 'string' || !HEX64_RE.test(member)) throw new TypeError('member must be 64 lowercase hex characters')
}

function checkHash (hash) {
  if (typeof hash !== 'string' || !HEX64_RE.test(hash)) throw new TypeError('expectedHash must be 64 lowercase hex characters')
}

function checkBlob (blob) {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== SEEN_BLOB_BYTES) throw new TypeError('blob must be ' + SEEN_BLOB_BYTES + ' bytes')
}

function sameHash (a, b) {
  return nodeCrypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

function writeAll (fd, buf) {
  let off = 0
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off)
}

function readAll (fd, size) {
  const buf = Buffer.alloc(size)
  let off = 0
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, off)
    if (n === 0) return null
    off += n
  }
  return buf
}

function fsyncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (err) {
    if (!FSYNC_DIR_IGNORED.has(err.code)) throw err
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

// O_NONBLOCK so a FIFO planted under a member name cannot hang the service;
// it is then refused by the fstat check.
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0)
const WIPE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0)

// nlink 1: a hard link to another inode would make forget() zero that inode.
function regularBlob (st) {
  return st.isFile() && st.size === SEEN_BLOB_BYTES && st.nlink === 1
}

function openSeenStore (dataDir, { guard = () => true, readOnly = false, log = noop, maxMembers = MAX_MEMBERS } = {}) {
  refuseSymlinkDir(dataDir)
  const dir = path.join(dataDir, DIR)
  let failed = false
  let dirBad = false
  // Set once a bad directory was logged, cleared when a good one is seen:
  // the periodic heal re-checks it every tick without logging each time.
  let dirNoted = false
  let tail = Promise.resolve()

  function note (reason) {
    try { log({ event: 'seen', reason }) } catch {}
  }

  // true when the directory exists, false when it does not yet. A symlink or
  // a non-directory marks the store unavailable until heal().
  function checkDir () {
    let st
    try {
      st = fs.lstatSync(dir)
    } catch (err) {
      if (err.code === 'ENOENT') return false
      // Unreadable is bad too, so a heal() that cannot see the directory
      // never reports it fixed.
      if (!dirNoted) note('diretorio-ilegivel')
      dirNoted = true
      dirBad = true
      throw fail('indisponivel')
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      if (!dirNoted) note('diretorio-invalido')
      dirNoted = true
      dirBad = true
      throw fail('indisponivel')
    }
    dirNoted = false
    return true
  }

  try {
    checkDir()
  } catch {}

  function usable () {
    if (failed || dirBad) throw fail('indisponivel')
  }

  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(noop)
    return p
  }

  // The current ciphertext, or null when the member has none. Anything this
  // module would not have written throws without touching it.
  function readCurrent (member) {
    if (!checkDir()) return null
    const file = path.join(dir, member)
    let st
    try {
      st = fs.lstatSync(file)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw fail('indisponivel')
    }
    if (!regularBlob(st)) {
      note('arquivo-invalido')
      throw fail('indisponivel')
    }
    let fd
    try {
      fd = fs.openSync(file, READ_FLAGS)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      note('arquivo-invalido')
      throw fail('indisponivel')
    }
    try {
      if (!regularBlob(fs.fstatSync(fd))) {
        note('arquivo-invalido')
        throw fail('indisponivel')
      }
      const buf = readAll(fd, SEEN_BLOB_BYTES)
      if (buf === null) {
        note('arquivo-invalido')
        throw fail('indisponivel')
      }
      return buf
    } finally {
      fs.closeSync(fd)
    }
  }

  function ensureDir () {
    if (checkDir()) return
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
      fs.chmodSync(dir, 0o700)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    checkDir()
  }

  function writeBlob (member, blob) {
    ensureDir()
    const tmp = path.join(dir, '.tmp.' + process.pid + '.' + nodeCrypto.randomBytes(8).toString('hex'))
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    let published = false
    try {
      try {
        fs.fchmodSync(fd, 0o600)
        writeAll(fd, Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, path.join(dir, member))
      published = true
    } finally {
      if (!published) {
        try { fs.unlinkSync(tmp) } catch {}
      }
    }
    fsyncDir(dir)
  }

  // Overwrites the inode with zeros before unlinking, so the ciphertext does
  // not linger in free blocks (the page-keys.js wipe precedent).
  function wipe (member) {
    const file = path.join(dir, member)
    const fd = fs.openSync(file, WIPE_FLAGS)
    try {
      if (!regularBlob(fs.fstatSync(fd))) {
        note('arquivo-invalido')
        throw fail('indisponivel')
      }
      // The name goes first, then the bytes are zeroed through the open fd:
      // a crash in between leaves no file at all, never a zeroed one that
      // would be served as a blob and block both a create and a delete.
      fs.unlinkSync(file)
      fsyncDir(dir)
      writeAll(fd, Buffer.alloc(SEEN_BLOB_BYTES))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  function members () {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch (err) {
      if (err.code === 'ENOENT') return 0
      throw fail('indisponivel')
    }
    let n = 0
    for (const name of names) if (HEX64_RE.test(name)) n++
    return n
  }

  function begin () {
    usable()
    if (readOnly) throw fail('indisponivel')
    if (!guard()) {
      note('guarda-recusou')
      throw fail('indisponivel')
    }
  }

  function acknowledge () {
    if (!guard()) {
      note('guarda-recusou')
      throw fail('indisponivel')
    }
  }

  function get (member) {
    checkMember(member)
    usable()
    const blob = readCurrent(member)
    if (blob === null) return null
    return { hash: blobHash(blob), blob }
  }

  function put ({ member, blob, expectedHash } = {}) {
    return enqueue(() => {
      checkMember(member)
      checkBlob(blob)
      checkHash(expectedHash)
      begin()
      const current = readCurrent(member)
      const hash = current === null ? HASH_NONE : blobHash(current)
      if (!sameHash(hash, expectedHash)) return { ok: false, conflict: true, hash, blob: current }
      if (current === null && members() >= maxMembers) {
        note('limite')
        throw fail('limite')
      }
      try {
        writeBlob(member, blob)
      } catch (err) {
        if (err.code === 'indisponivel') throw err
        note('escrita-falhou')
        throw fail('indisponivel')
      }
      acknowledge()
      return { ok: true, hash: blobHash(blob) }
    })
  }

  function forget (member, expectedHash) {
    return enqueue(() => {
      checkMember(member)
      checkHash(expectedHash)
      begin()
      const current = readCurrent(member)
      if (current === null) return { ok: true, changed: false }
      const hash = blobHash(current)
      if (!sameHash(hash, expectedHash)) return { ok: false, conflict: true, hash }
      try {
        wipe(member)
      } catch (err) {
        if (err.code === 'indisponivel') throw err
        note('remocao-falhou')
        throw fail('indisponivel')
      }
      acknowledge()
      return { ok: true, changed: true }
    })
  }

  // Re-checks the directory only; a member file is never rewritten here.
  // True only when a bad directory was found fixed, so the periodic heal
  // (startHeal in commands/account.js) logs 'reparado' once, not each tick.
  function heal () {
    return enqueue(() => {
      if (failed) return false
      const wasBad = dirBad
      dirBad = false
      try {
        checkDir()
      } catch {}
      return wasBad && !failed && !dirBad
    })
  }

  function count () {
    usable()
    checkDir()
    return members()
  }

  return {
    get,
    put,
    forget,
    heal,
    count,
    fail () { failed = true },
    available () { return !failed && !dirBad }
  }
}

module.exports = {
  openSeenStore,
  DIR,
  MAX_MEMBERS
}
