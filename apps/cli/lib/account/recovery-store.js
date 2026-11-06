'use strict'

// The wrapped recovery blobs the account service holds: for each lookupId
// (an HKDF output of an extra passkey's PRF or of a recovery code, never the
// secret itself) the member key it belongs to, its kind ('passkey' or
// 'code') and the secretbox nonce and ciphertext that wrap the member's root.
// ONE sidecar file, <dataDir>/recovery.json (mode 0o600), always replaced
// whole through writeJsonAtomic (packages/core/lib/store.js: O_EXCL temp,
// fsync, rename, dir fsync). It is NOT part of account/store.js for the same
// reason as terms-store.js: older and newer builds must keep opening the
// same data dir, so directory.json, directory.journal.* and directory.hwm
// are never read or written here. Never an e-mail, a sub or a username, and
// nothing from this file is logged or put in an error: a lookupId finds a
// blob, a blob is the member's wrapped root.
//
// Opening never creates, mkdirs or chmods anything (a missing file means no
// entry yet; the first put writes it), and a readOnly store never writes at
// all. Validation is total: a file this module would not have written (bad
// JSON, unknown keys, a bad id, row or tombstone, an id both live and
// removed) is never rewritten, and every method then throws
// { code: 'indisponivel' } until an operator repairs it. Errors carry only a
// token in `code`; bad argument shapes throw TypeError with a fixed message.
//
// Every write runs in one in-process queue against a copy of the state and
// first re-reads the file: the service lock goes stale after 30 s
// (account/server.js LOCK_STALE_MS) and writeJsonAtomic renames
// unconditionally, so another holder may have replaced the file meanwhile.
// guard() is asked before the write and again after it: a holder that lost
// the lock meanwhile does not acknowledge. Memory changes only once the
// write landed and guard() still answered true; a refused or failed request
// leaves the store dirty, so the next write or heal() merges and rewrites
// before it answers. guard() === false refuses that request only; fail()
// and a malformed file make the store unavailable for good.
//
// Rows are deleted, so a plain union (terms-store.js) would bring a removed
// row back from a stale copy. Every row and every tombstone carries a
// generation drawn from ONE store-level counter, `seq` (persisted in the
// file, merged as max(memory, disk)): each put, each remove and each
// tombstone normalize() writes takes gen = ++seq. Generations are therefore
// monotonic across the whole store, never per id, so neither a pruned
// tombstone nor a clock that went back can let an older write beat a newer
// one. A merge keeps, per id, whichever record has the higher gen, row or
// tombstone (ties keep memory): a remove beats the stale row it buried, and
// a later re-put beats the tombstone. A tombstone keeps its member: only
// that member may re-put the id.
//
// Tombstones are pruned once older than TOMBSTONE_TTL_MS (by removedAt), and
// each member keeps at most TOMBSTONE_MAX_PER_MEMBER of them (the lowest gens
// go first). The cap never drops a tombstone younger than STALE_WINDOW_MS
// (one just written, or one whose removedAt is ahead of this clock) nor the
// member's newest tombstone, so a member may briefly hold more than the cap;
// the TTL is far longer than that window, so it never drops a fresh one.
// Residual: a copy of the file older than a pruned tombstone may still
// resurrect that row. Accepted, since a stale writer's rename lands within
// one lock period (30 s) and is healed within one heal interval, far inside
// STALE_WINDOW_MS; a holder whose clock runs more than the TTL behind may
// also see its fresh tombstones pruned by another holder.
//
// Reads (list, fetch) after an uncertain write (a failed write, or guard()
// refusing after the rename) first re-read the file and adopt the merge, or
// throw { code: 'indisponivel' }: the file may hold what memory does not,
// and an answer from stale memory could deny a row that is there. A read
// never clears the dirty mark; only a durable write does.
//
// Caps: MAX_PASSKEYS live 'passkey' rows and one live 'code' row per member;
// tombstones never count. A merge of two holders' copies may hold more
// passkeys (both rows are kept: dropping one would silently lose a way back
// in), and put() then refuses new ones. Of two live code rows after a merge
// only the strictly higher gen (the newest write) stays and the others are
// buried, so a replaced code stops opening anything. Rows whose gens TIE
// (a stale writer that lost its lock and its replacement both took seq + 1)
// both stay live: neither write is newer, and choosing by lookupId could
// delete the code that was acknowledged. The next code put buries both.

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'recovery.json'
const VERSION = 1
const MAX_PASSKEYS = 4
const TOMBSTONE_MAX_PER_MEMBER = 32
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000
const STALE_WINDOW_MS = 10 * 60 * 1000
const KINDS = ['passkey', 'code']
const BLOB_KEYS = ['v', 'kind', 'nonce', 'ciphertext']
const ENTRY_KEYS = ['member', 'kind', 'nonce', 'ciphertext', 'createdAt', 'gen']
const TOMB_KEYS = ['member', 'removedAt', 'gen']
const FILE_KEYS = ['v', 'seq', 'entries', 'removed']
// 24-byte secretbox nonce; 66-byte plaintext + 16-byte MAC.
const NONCE_BYTES = 24
const CIPHERTEXT_BYTES = 82

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function exactKeys (obj, keys) {
  return Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validId (id) {
  return isLowerHex(id, 32)
}

function validMember (m) {
  return isLowerHex(m, 32)
}

function validKind (k) {
  return KINDS.includes(k)
}

function validGen (g) {
  return Number.isSafeInteger(g) && g >= 1
}

// Same shape check as packages/web-member/lib/recovery.js isBlob, duplicated
// because apps/cli does not depend on web-member.
function isBlob (v) {
  return isPlainObject(v) &&
    exactKeys(v, BLOB_KEYS) &&
    v.v === 1 &&
    validKind(v.kind) &&
    isLowerHex(v.nonce, NONCE_BYTES) &&
    isLowerHex(v.ciphertext, CIPHERTEXT_BYTES)
}

function validEntry (e) {
  return isPlainObject(e) &&
    exactKeys(e, ENTRY_KEYS) &&
    validMember(e.member) &&
    validKind(e.kind) &&
    isLowerHex(e.nonce, NONCE_BYTES) &&
    isLowerHex(e.ciphertext, CIPHERTEXT_BYTES) &&
    isCanonicalIso(e.createdAt) &&
    validGen(e.gen)
}

function validTomb (r) {
  return isPlainObject(r) &&
    exactKeys(r, TOMB_KEYS) &&
    validMember(r.member) &&
    isCanonicalIso(r.removedAt) &&
    validGen(r.gen)
}

function copyEntry (e) {
  return { member: e.member, kind: e.kind, nonce: e.nonce, ciphertext: e.ciphertext, createdAt: e.createdAt, gen: e.gen }
}

function copyTomb (r) {
  return { member: r.member, removedAt: r.removedAt, gen: r.gen }
}

// A file that is not a valid recovery.json, as opposed to a read that failed.
function invalidFile () {
  return Object.assign(new Error('recuperação inválida'), { invalid: true })
}

function emptyState () {
  return { v: VERSION, seq: 0, entries: Object.create(null), removed: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, FILE_KEYS) || obj.v !== VERSION) throw invalidFile()
  if (!Number.isSafeInteger(obj.seq) || obj.seq < 0) throw invalidFile()
  if (!isPlainObject(obj.entries) || !isPlainObject(obj.removed)) throw invalidFile()
  // No per-member row ceiling here: a merge of two holders' copies may pass
  // MAX_PASSKEYS, and a load-time ceiling would make this store refuse a file
  // it wrote itself.
  const state = emptyState()
  state.seq = obj.seq
  for (const [id, e] of Object.entries(obj.entries)) {
    if (!validId(id) || !validEntry(e) || e.gen > obj.seq) throw invalidFile()
    state.entries[id] = copyEntry(e)
  }
  for (const [id, r] of Object.entries(obj.removed)) {
    if (!validId(id) || !validTomb(r) || r.gen > obj.seq || has(state.entries, id)) throw invalidFile()
    state.removed[id] = copyTomb(r)
  }
  return state
}

// The file's state, or null when it does not exist. Anything else that is
// not a valid regular file throws.
function readState (file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!st.isFile()) throw invalidFile()
  const text = fs.readFileSync(file, 'utf8')
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    throw invalidFile()
  }
  return fromJson(obj)
}

// What changes when the file is replaced or rewritten, or null when absent.
function fingerprint (file) {
  try {
    const st = fs.lstatSync(file)
    return [st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function toJson (state) {
  const entries = {}
  for (const id of Object.keys(state.entries).sort()) entries[id] = copyEntry(state.entries[id])
  const removed = {}
  for (const id of Object.keys(state.removed).sort()) removed[id] = copyTomb(state.removed[id])
  return { v: VERSION, seq: state.seq, entries, removed }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

function genOf (state, id) {
  if (!state) return 0
  if (has(state.entries, id)) return state.entries[id].gen
  if (has(state.removed, id)) return state.removed[id].gen
  return 0
}

// Lowest gen first; ties by id so the order never depends on the source.
function byGen (a, b) {
  if (a.gen !== b.gen) return a.gen - b.gen
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// Oldest first; ties by gen then id so the order never depends on the source.
function byCreated (a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.gen !== b.gen) return a.gen - b.gen
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function liveRows (state, member) {
  const out = []
  for (const [id, e] of Object.entries(state.entries)) {
    if (e.member === member) out.push({ id, ...e })
  }
  return out.sort(byCreated)
}

// The next generation: every write and every tombstone takes one, so gens
// never repeat or go back within one store.
function nextGen (state) {
  state.seq += 1
  return state.seq
}

// One live code row per member (the highest gen stays, rows with a lower
// gen are buried under fresh gens; rows tied at the highest gen all stay),
// then tombstones older than the TTL go, then each
// member keeps its TOMBSTONE_MAX_PER_MEMBER highest-gen tombstones; that cap
// never drops a tombstone younger than STALE_WINDOW_MS or the member's
// newest one. put(), remove() and merge() all end here, so every copy this
// holder writes agrees on what is kept.
function normalize (state, nowMs) {
  const codes = new Map()
  for (const [id, e] of Object.entries(state.entries)) {
    if (e.kind !== 'code') continue
    if (!codes.has(e.member)) codes.set(e.member, [])
    codes.get(e.member).push({ id, ...e })
  }
  const removedAt = new Date(nowMs).toISOString()
  for (const list of codes.values()) {
    if (list.length < 2) continue
    list.sort(byGen)
    const top = list[list.length - 1].gen
    for (const r of list) {
      if (r.gen >= top) continue
      delete state.entries[r.id]
      state.removed[r.id] = { member: r.member, removedAt, gen: nextGen(state) }
    }
  }
  const perMember = new Map()
  for (const [id, r] of Object.entries(state.removed)) {
    if (!perMember.has(r.member)) perMember.set(r.member, [])
    perMember.get(r.member).push({ id, ...r })
  }
  const cutoff = nowMs - TOMBSTONE_TTL_MS
  const young = nowMs - STALE_WINDOW_MS
  for (const list of perMember.values()) {
    list.sort(byGen)
    const newest = list[list.length - 1]
    let kept = list.length
    for (const r of list) {
      if (Date.parse(r.removedAt) < cutoff) {
        delete state.removed[r.id]
        kept--
      }
    }
    for (const r of list) {
      if (kept <= TOMBSTONE_MAX_PER_MEMBER) break
      if (!has(state.removed, r.id) || r === newest || Date.parse(r.removedAt) >= young) continue
      delete state.removed[r.id]
      kept--
    }
  }
  return state
}

// Per lookupId the record (row or tombstone) with the higher gen; ties keep
// memory.
function merge (mem, disk, nowMs) {
  const out = emptyState()
  out.seq = Math.max(mem.seq, disk ? disk.seq : 0)
  const ids = new Set([...Object.keys(mem.entries), ...Object.keys(mem.removed)])
  if (disk) for (const id of [...Object.keys(disk.entries), ...Object.keys(disk.removed)]) ids.add(id)
  for (const id of ids) {
    const src = disk && genOf(disk, id) > genOf(mem, id) ? disk : mem
    if (has(src.entries, id)) out.entries[id] = copyEntry(src.entries[id])
    else out.removed[id] = copyTomb(src.removed[id])
  }
  return normalize(out, nowMs)
}

function openRecoveryStore (dataDir, { now = Date.now, readOnly = false, guard = () => true, log = () => {} } = {}) {
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, FILE)
  let state = emptyState()
  let failed = false
  let dirty = false
  // Fingerprint of the file as heal() last found it equal to memory.
  let healed
  try {
    state = readState(file) || emptyState()
  } catch {
    failed = true
  }
  let tail = Promise.resolve()

  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  // Memory changes only after the write landed and guard() still answers
  // true. The file may hold `next` after a failure; the store stays dirty so
  // the next write or heal merges and rewrites first. An unreadable file
  // marks the store unavailable.
  function persist (next) {
    try {
      writeJsonAtomic(file, toJson(next), 0o600)
    } catch (err) {
      dirty = true
      try {
        readState(file)
      } catch {
        failed = true
      }
      throw err
    }
    if (!guard()) {
      dirty = true
      throw fail('indisponivel')
    }
    dirty = false
    state = next
  }

  // Re-reads the file and returns the merge and whether it must be written
  // even when the request itself changes nothing.
  function reread () {
    usable()
    if (readOnly) throw fail('indisponivel')
    if (!guard()) throw fail('indisponivel')
    let disk
    try {
      disk = readState(file)
    } catch (err) {
      if (err.invalid === true) failed = true
      throw fail('indisponivel')
    }
    const next = merge(state, disk, now())
    const stale = dirty || canonical(next) !== canonical(disk || emptyState())
    return { next, stale }
  }

  // A request that changes nothing still writes a merge the file lacks;
  // otherwise it adopts the disk state.
  function settle (next, stale) {
    if (stale) persist(next)
    else state = next
  }

  function put ({ member, kind, lookupId, blob } = {}) {
    return enqueue(() => {
      if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
      if (!validKind(kind)) throw new TypeError('invalid kind')
      if (!validId(lookupId)) throw new TypeError('lookupId must be 64 lowercase hex characters')
      if (!isBlob(blob)) throw new TypeError('invalid blob')
      if (blob.kind !== kind) throw fail('pedido-invalido')
      const { next, stale } = reread()
      const cur = has(next.entries, lookupId) ? next.entries[lookupId] : null
      if (cur) {
        if (cur.member !== member || cur.kind !== kind) {
          settle(next, stale)
          throw fail('pedido-invalido')
        }
        settle(next, stale)
        return { changed: false, createdAt: cur.createdAt }
      }
      // A tombstone keeps its member: another member may not take the id.
      if (has(next.removed, lookupId) && next.removed[lookupId].member !== member) {
        settle(next, stale)
        throw fail('pedido-invalido')
      }
      const rows = liveRows(next, member)
      if (kind === 'passkey' && rows.filter((r) => r.kind === 'passkey').length >= MAX_PASSKEYS) {
        settle(next, stale)
        throw fail('limite-recuperacao')
      }
      const nowMs = now()
      const createdAt = new Date(nowMs).toISOString()
      if (kind === 'code') {
        for (const r of rows) {
          if (r.kind !== 'code') continue
          delete next.entries[r.id]
          next.removed[r.id] = { member, removedAt: createdAt, gen: nextGen(next) }
        }
      }
      // The new row takes the highest gen, so normalize() keeps it over any
      // other code row whatever the clock says.
      delete next.removed[lookupId]
      next.entries[lookupId] = { member, kind, nonce: blob.nonce, ciphertext: blob.ciphertext, createdAt, gen: nextGen(next) }
      persist(normalize(next, nowMs))
      return { changed: true, createdAt }
    })
  }

  function remove ({ member, lookupId } = {}) {
    return enqueue(() => {
      if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
      if (!validId(lookupId)) throw new TypeError('lookupId must be 64 lowercase hex characters')
      const { next, stale } = reread()
      const cur = has(next.entries, lookupId) ? next.entries[lookupId] : null
      if (!cur) {
        settle(next, stale)
        return { changed: false }
      }
      if (cur.member !== member) {
        settle(next, stale)
        throw fail('pedido-invalido')
      }
      const nowMs = now()
      delete next.entries[lookupId]
      next.removed[lookupId] = { member, removedAt: new Date(nowMs).toISOString(), gen: nextGen(next) }
      persist(normalize(next, nowMs))
      return { changed: true }
    })
  }

  // Excluir conta: every entry of `member` in one write, each leaving the
  // same tombstone remove() leaves. -> { changed }
  function removeMember (member) {
    return enqueue(() => {
      if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
      const { next, stale } = reread()
      const ids = Object.keys(next.entries).filter((id) => next.entries[id].member === member)
      if (ids.length === 0) {
        settle(next, stale)
        return { changed: false }
      }
      const nowMs = now()
      for (const id of ids) {
        delete next.entries[id]
        next.removed[id] = { member, removedAt: new Date(nowMs).toISOString(), gen: nextGen(next) }
      }
      persist(normalize(next, nowMs))
      return { changed: true }
    })
  }

  // Writes the merge of the file and memory back when the file lacks
  // anything this holder knows (a stale writer's rename may have dropped an
  // acknowledged row or tombstone) or a previous write failed. True when it
  // wrote. Never throws, never writes a file it would not have written.
  function heal () {
    return enqueue(() => {
      if (failed || readOnly || !guard()) return false
      let seen, disk
      try {
        seen = fingerprint(file)
        if (!dirty && seen === healed) return false
        disk = readState(file)
      } catch (err) {
        // Only a malformed file is final; a failed read is tried again at
        // the next interval. The log carries the error code only.
        if (err.invalid === true) failed = true
        else log({ event: 'recovery', reason: 'leitura-falhou', code: typeof err.code === 'string' ? err.code : 'desconhecido' })
        return false
      }
      const next = merge(state, disk, now())
      if (dirty || canonical(next) !== canonical(disk || emptyState())) {
        persist(next)
        healed = undefined
        return true
      }
      state = next
      healed = seen
      return false
    }).catch(() => false)
  }

  // After an uncertain write the file may hold what memory does not: adopt
  // the merge of both before answering (as heal() would, without writing),
  // or refuse. Only a durable write clears `dirty`, never a read: a file
  // whose rename landed but whose directory fsync failed may equal the merge
  // and still not survive a crash, so the next write or heal() rewrites it
  // (and a repeated put writes instead of answering from that file). No
  // guard(): reading needs no lock.
  function fresh () {
    usable()
    if (!dirty) return
    let disk
    try {
      disk = readState(file)
    } catch (err) {
      if (err.invalid === true) failed = true
      throw fail('indisponivel')
    }
    state = merge(state, disk, now())
  }

  function list (member) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
    fresh()
    return liveRows(state, member).map((r) => ({ lookupId: r.id, kind: r.kind, createdAt: r.createdAt }))
  }

  function fetch (lookupId) {
    if (!validId(lookupId)) throw new TypeError('lookupId must be 64 lowercase hex characters')
    fresh()
    if (!has(state.entries, lookupId)) return null
    const e = state.entries[lookupId]
    return { member: e.member, kind: e.kind, blob: { v: 1, kind: e.kind, nonce: e.nonce, ciphertext: e.ciphertext } }
  }

  return {
    put,
    remove,
    removeMember,
    heal,
    list,
    fetch,
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openRecoveryStore,
  isBlob,
  FILE,
  MAX_PASSKEYS,
  TOMBSTONE_MAX_PER_MEMBER,
  TOMBSTONE_TTL_MS,
  STALE_WINDOW_MS
}
