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
// The file is { v: 2, seq, entries, removed, floors }: entries maps lookupId
// to its row, removed maps lookupId to its tombstone and floors maps a member
// key to a gen (both below). A version 1 file (the same without floors) is
// still read; the next write that changes anything writes version 2, and
// nothing is rewritten only to change the version. An older build of the
// service refuses a version 2 file as malformed and never rewrites it, so
// after a rollback /account/recovery/* answers 503 until the newer build
// returns.
//
// Opening never creates, mkdirs or chmods anything (a missing file means no
// entry yet; the first put writes it), and a readOnly store never writes at
// all. Validation is total: a file this module would not have written (bad
// JSON, unknown keys, a bad id, row, tombstone or floor, an id both live and
// removed) is never rewritten, and every method then throws
// { code: 'indisponivel' } until an operator repairs it. Errors carry only a
// token in `code`; bad argument shapes throw TypeError with a fixed message.
//
// Every write runs in one in-process queue against a copy of the state and
// first re-reads the file: the service lock goes stale after 30 s
// (account/server.js LOCK_STALE_MS), so another holder may have replaced the
// file meanwhile. guard() is asked three times: before the re-read, right
// before the rename (writeJsonAtomic's beforeRename, after the temp file is
// written and fsynced) and after the rename. A false answer before the
// rename leaves the file as it was, so a process whose event loop stalled
// past LOCK_STALE_MS (a long fsync, a suspended process) and lost the lock
// meanwhile never replaces what the new holder wrote and acknowledged. The
// answer after the rename decides whether the write is acknowledged. The
// service's guard (../commands/account.js) counts the lock as held only
// while it carries this process's token and its mtime is younger than the
// stale window minus one heartbeat, so a holder whose heartbeat fell behind
// stops writing before another process can read the lock as stale. Memory
// changes only once the write landed and guard() still answered true; a
// failed write, or one the check after the rename refused, leaves the store
// dirty, so the next write or heal() merges and rewrites before it answers.
// A refusal before the rename leaves file and memory as they were. guard()
// === false (or a throw from it) refuses that request only; fail() and a
// malformed file make the store unavailable for good.
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
//
// Each pruned tombstone, by the TTL or by the cap, raises its member's floor
// (`floors`) to its gen; floors only go up, a merge takes the max per
// member, and a floor never passes seq. When this holder merges the file
// into its memory, a row only the file holds is dropped when its gen is at
// or under memory's floor for that member: memory had the row, removed it
// and pruned the tombstone. So a copy on disk older than memory that still
// holds a removed row (a stale writer's rename) cannot bring it back through
// heal(), a read after an uncertain write or the merge before a write,
// however long ago the tombstone went. The file's floor never drops a row
// memory holds: the service takes the lock before it opens the store and
// fails the store for good when it loses the lock (../commands/account.js),
// so memory is never behind the file on their shared history, and a file
// whose floor passes a row in memory comes from another history (a copy put
// back after the service started from an older copy or from no file), whose
// floors say nothing about memory's rows. A row put later takes a gen above
// every floor, since put() merges first. A floor keeps the member key after
// the member's last tombstone is pruned, Excluir conta included. Tombstones
// pruned by a version 1 build left no floor.
//
// Tombstones are pruned inside normalize(), which writes and merges reach;
// heal() also runs it when memory holds a tombstone past the TTL, so the
// 30-day removal holds on a store nobody writes to.
//
// Residual: a holder suspended in the few synchronous instructions between
// the check right before the rename and the rename itself while another
// process takes the lock over still lands its rename after the takeover
// (with the service's guard, a suspension of more than one heartbeat, or
// less when the holder had stalled past the whole stale window and its
// heartbeat refreshed the lock just before a taker that had already read
// it as stale replaced it). It answers 'indisponivel', since the check
// after the rename fails, and the new holder's heal() rewrites what it
// acknowledged, if it is still running. A merge needs two copies. A copy
// put back while no holder runs is read as it is: it lacks every row written after it and holds again the
// rows removed after it, with nothing left to bury them. A copy from another
// history put back while a holder runs is a union apart from memory's floor:
// its rows removed in that history may come back, and those at or under
// memory's floor for their member go. A holder whose clock runs behind
// another's by more than STALE_WINDOW_MS (or the TTL) may see its fresh
// tombstones pruned by the cap (or the TTL) on that other holder; the rows
// they buried stay buried under the floor.
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
const VERSION = 2
const MAX_PASSKEYS = 4
const TOMBSTONE_MAX_PER_MEMBER = 32
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000
const STALE_WINDOW_MS = 10 * 60 * 1000
const KINDS = ['passkey', 'code']
const BLOB_KEYS = ['v', 'kind', 'nonce', 'ciphertext']
const ENTRY_KEYS = ['member', 'kind', 'nonce', 'ciphertext', 'createdAt', 'gen']
const TOMB_KEYS = ['member', 'removedAt', 'gen']
const FILE_KEYS = ['v', 'seq', 'entries', 'removed', 'floors']
// Version 1 had no floors; it is still read, and the next write that changes
// anything is version 2.
const FILE_KEYS_V1 = ['v', 'seq', 'entries', 'removed']
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
  return { v: VERSION, seq: 0, entries: Object.create(null), removed: Object.create(null), floors: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj)) throw invalidFile()
  const v1 = obj.v === 1 && exactKeys(obj, FILE_KEYS_V1)
  if (!v1 && (obj.v !== VERSION || !exactKeys(obj, FILE_KEYS))) throw invalidFile()
  if (!Number.isSafeInteger(obj.seq) || obj.seq < 0) throw invalidFile()
  if (!isPlainObject(obj.entries) || !isPlainObject(obj.removed)) throw invalidFile()
  if (!v1 && !isPlainObject(obj.floors)) throw invalidFile()
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
  if (!v1) {
    for (const [member, gen] of Object.entries(obj.floors)) {
      if (!validMember(member) || !validGen(gen) || gen > obj.seq) throw invalidFile()
      state.floors[member] = gen
    }
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
  const floors = {}
  for (const m of Object.keys(state.floors).sort()) floors[m] = state.floors[m]
  return { v: VERSION, seq: state.seq, entries, removed, floors }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

function floorOf (state, member) {
  return has(state.floors, member) ? state.floors[member] : 0
}

// A pruned tombstone leaves its gen behind as the member's floor, so a copy
// that still holds the row it buried cannot bring it back (merge()).
function raiseFloor (state, member, gen) {
  if (gen > floorOf(state, member)) state.floors[member] = gen
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
// newest one. Each pruned tombstone raises its member's floor. put(), remove()
// and merge() all end here, so every copy this holder writes agrees on what
// is kept.
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
        raiseFloor(state, r.member, r.gen)
        kept--
      }
    }
    for (const r of list) {
      if (kept <= TOMBSTONE_MAX_PER_MEMBER) break
      if (!has(state.removed, r.id) || r === newest || Date.parse(r.removedAt) >= young) continue
      delete state.removed[r.id]
      raiseFloor(state, r.member, r.gen)
      kept--
    }
  }
  return state
}

// Per lookupId the record (row or tombstone) with the higher gen; ties keep
// memory. A row only the disk holds is dropped when its gen is at or under
// memory's floor for its member: memory removed it and pruned the tombstone.
// Never the other way (see the top of the file), and a copy's own floor never
// drops its rows, since a member may keep an older row it never removed
// under it. Floors merge as max.
function merge (mem, disk, nowMs) {
  const out = emptyState()
  out.seq = Math.max(mem.seq, disk ? disk.seq : 0)
  for (const src of disk ? [mem, disk] : [mem]) {
    for (const [member, gen] of Object.entries(src.floors)) raiseFloor(out, member, gen)
  }
  const ids = new Set([...Object.keys(mem.entries), ...Object.keys(mem.removed)])
  if (disk) for (const id of [...Object.keys(disk.entries), ...Object.keys(disk.removed)]) ids.add(id)
  for (const id of ids) {
    const src = disk && genOf(disk, id) > genOf(mem, id) ? disk : mem
    if (has(src.entries, id)) {
      const e = src.entries[id]
      if (src === disk && genOf(mem, id) === 0 && e.gen <= floorOf(mem, e.member)) continue
      out.entries[id] = copyEntry(e)
    } else out.removed[id] = copyTomb(src.removed[id])
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

  // guard() as a boolean: a guard that throws counts as a refusal at every
  // call site, so a throw never skips the dirty mark after a rename.
  function held () {
    try {
      return Boolean(guard())
    } catch {
      return false
    }
  }

  // Memory changes only after the write landed and guard() still answers
  // true. The file may hold `next` after a failure; the store stays dirty so
  // the next write or heal merges and rewrites first. An unreadable file
  // marks the store unavailable. guard() is asked again right before the
  // rename: a holder that lost the lock while it read, merged or fsynced
  // leaves the file as the new holder wrote it. That refusal is for the
  // request only, like the one before the re-read: the file is untouched and
  // memory unchanged, so the store is neither failed nor dirty.
  function persist (next) {
    let refused = false
    const beforeRename = () => {
      if (held()) return
      refused = true
      throw fail('indisponivel')
    }
    try {
      writeJsonAtomic(file, toJson(next), 0o600, { beforeRename })
    } catch (err) {
      if (refused) throw fail('indisponivel')
      dirty = true
      try {
        readState(file)
      } catch {
        failed = true
      }
      throw err
    }
    if (!held()) {
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
    if (!held()) throw fail('indisponivel')
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

  // True when memory holds a tombstone past the TTL. Pruning otherwise runs
  // only inside writes and merges, so without this check an idle store
  // would keep a removal mark past 30 days for as long as nobody writes.
  function expiredTombstone () {
    const cutoff = now() - TOMBSTONE_TTL_MS
    for (const id in state.removed) {
      if (Date.parse(state.removed[id].removedAt) < cutoff) return true
    }
    return false
  }

  // Writes the merge of the file and memory back when the file lacks
  // anything this holder knows (a stale writer's rename may have dropped an
  // acknowledged row or tombstone), a previous write failed, or a tombstone
  // passed the TTL (the merge prunes it and raises the floor). True when it
  // wrote. Never throws, never writes a file it would not have written.
  function heal () {
    return enqueue(() => {
      if (failed || readOnly || !held()) return false
      let seen, disk
      try {
        seen = fingerprint(file)
        if (!dirty && seen === healed && !expiredTombstone()) return false
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
