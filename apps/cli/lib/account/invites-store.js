'use strict'

// The signup invites members have issued: for each invite a random slot, the
// SHA-256 of its code while it is unused, the inviter's member key, when it
// was created and whether it was used. ONE sidecar file,
// <dataDir>/invites.json (mode 0o600), always replaced whole through
// writeJsonAtomic (packages/core/lib/store.js: O_EXCL temp, fsync, rename,
// dir fsync). It is NOT part of account/store.js on purpose: that store's
// applyEntry throws on an op it does not know and it only scans
// directory.journal.* names, so a separate file keeps older and newer builds
// able to open the same data dir.
//
// Privacy: the code itself is never stored, so a leaked file mints nothing.
// Once an invite is used its hash is dropped (id: null) and no use time is
// kept, so this file cannot be joined with the directory link that recorded
// the signup. Who consumed an invite is recorded nowhere. Never an e-mail, a
// name, a sub, a username, a pending id or any key but the inviter's here.
//
// Opening never creates, mkdirs or chmods anything (a missing file means no
// invite yet; the first issue writes it), and a readOnly store never writes
// at all. Validation is total: a file this module would not have written
// (bad JSON, unknown keys, a bad row, a duplicate slot or id) is never
// rewritten, and every method then throws { code: 'indisponivel' } until an
// operator repairs it. Errors carry only a token in `code`; bad argument
// shapes throw TypeError.
//
// Every write runs in one in-process queue against a copy of the state and
// first re-reads the file: the service lock goes stale after 30 s and
// writeJsonAtomic renames unconditionally, so another holder may have
// replaced the file meanwhile. Rows are add-only and use is monotonic, so
// disk and memory are union-merged by slot (used beats unused, a dropped id
// beats a kept one); two copies of one slot that disagree on inviter,
// createdAt or a kept id mean a file this lineage did not write, and the
// store becomes unavailable without writing. The merge also marks used every
// row whose id the directory already reports used (isUsed): the directory is
// the authority on use, so a failed consume heals on the next write. The
// state is swapped only after the write returned, and guard() is asked again
// afterwards: a holder that lost the lock meanwhile does not acknowledge, and
// the store stays dirty so the next write or heal merge-writes first.
//
// Remaining window, inherent without OS file locks: the guard and the rename
// are separate syscalls, so a stalled writer's rename can still land after a
// takeover and replace the new holder's file. That write is never
// acknowledged, and whatever it dropped is written back within one heal
// interval by the current holder, which keeps everything it acknowledged in
// memory. What remains is a crash of the holder inside that interval.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { dayStart, DAY_MS, DAY_OFFSET_MS } = require('@varanda/core/lib/activity')

const FILE = 'invites.json'
const VERSION = 1
const CODE_RE = /^[A-Za-z0-9_-]{43}$/
const WEEK_MS = 7 * DAY_MS
const INVITE_TTL_MS = 7 * DAY_MS
const MAX_ROWS = 100000
const PER_WEEK_MAX = 100
const ROW_KEYS = ['slot', 'id', 'inviter', 'createdAt', 'used']

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

function validMember (m) {
  return isLowerHex(m, 32)
}

function validId (id) {
  return isLowerHex(id, 32)
}

function validSlot (s) {
  return isLowerHex(s, 16)
}

function iso (ms) {
  return new Date(ms).toISOString()
}

// Monday 00:00 Brasília of the week containing ms. The weekday is read from
// the shifted instant in UTC, so the process time zone never matters.
function weekStart (ms) {
  const day = dayStart(ms)
  return day - ((new Date(day + DAY_OFFSET_MS).getUTCDay() + 6) % 7) * DAY_MS
}

function weekEnd (ms) {
  return weekStart(ms) + WEEK_MS
}

function newCode () {
  return nodeCrypto.randomBytes(32).toString('base64url')
}

function inviteId (code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new TypeError('code must be 43 base64url characters')
  return nodeCrypto.createHash('sha256').update(code).digest('hex')
}

function validRow (r) {
  return isPlainObject(r) &&
    exactKeys(r, ROW_KEYS) &&
    validSlot(r.slot) &&
    typeof r.used === 'boolean' &&
    (r.id === null ? r.used === true : validId(r.id)) &&
    validMember(r.inviter) &&
    isCanonicalIso(r.createdAt)
}

function copyRow (r) {
  return { slot: r.slot, id: r.id, inviter: r.inviter, createdAt: r.createdAt, used: r.used }
}

// Oldest first; ties by slot so the order never depends on the source.
function byDate (a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0
}

function emptyState () {
  return { v: VERSION, invites: [] }
}

// Throws on a duplicate slot or a duplicate kept id.
function checkUnique (rows) {
  const slots = new Set()
  const ids = new Set()
  for (const r of rows) {
    if (slots.has(r.slot)) throw new Error('convites inválidos')
    slots.add(r.slot)
    if (r.id === null) continue
    if (ids.has(r.id)) throw new Error('convites inválidos')
    ids.add(r.id)
  }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'invites']) || obj.v !== VERSION) throw new Error('convites inválidos')
  if (!Array.isArray(obj.invites)) throw new Error('convites inválidos')
  // No row-count ceiling here: MAX_ROWS only limits issue(). A heal after a
  // takeover writes the union of two valid copies, which may pass it, and a
  // load-time ceiling would make this store refuse a file it wrote itself.
  for (const r of obj.invites) {
    if (!validRow(r)) throw new Error('convites inválidos')
  }
  const invites = obj.invites.map(copyRow)
  checkUnique(invites)
  return { v: VERSION, invites: invites.sort(byDate) }
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
  if (!st.isFile()) throw new Error('convites inválidos')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function toJson (state) {
  return { v: VERSION, invites: state.invites.map(copyRow) }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

// Union by slot of memory and the file, then every kept id the directory
// reports used is dropped. A used row never keeps its id. Throws when two
// copies of one slot disagree on what never changes.
function merge (mem, disk, used) {
  const bySlot = new Map()
  for (const r of mem.invites) bySlot.set(r.slot, copyRow(r))
  for (const r of (disk ? disk.invites : [])) {
    const cur = bySlot.get(r.slot)
    if (!cur) {
      bySlot.set(r.slot, copyRow(r))
      continue
    }
    if (cur.inviter !== r.inviter || cur.createdAt !== r.createdAt) throw new Error('convites inválidos')
    if (cur.id !== null && r.id !== null && cur.id !== r.id) throw new Error('convites inválidos')
    cur.used = cur.used || r.used
    if (r.id === null) cur.id = null
  }
  const invites = [...bySlot.values()]
  for (const r of invites) {
    if (r.id !== null && (r.used || used(r.id))) {
      r.used = true
      r.id = null
    }
  }
  checkUnique(invites)
  return { v: VERSION, invites: invites.sort(byDate) }
}

function openInvitesStore (dataDir, { now = Date.now, readOnly = false, guard = () => true, perWeek = null, isUsed = () => false } = {}) {
  if (perWeek !== null && !(Number.isSafeInteger(perWeek) && perWeek >= 1 && perWeek <= PER_WEEK_MAX)) {
    throw new TypeError('perWeek must be null or an integer from 1 to ' + PER_WEEK_MAX)
  }
  if (typeof isUsed !== 'function') throw new TypeError('isUsed must be a function')
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, FILE)
  let state = emptyState()
  let byId = new Map()
  let failed = false
  let dirty = false

  function setState (next) {
    state = next
    byId = new Map()
    for (const r of state.invites) {
      if (r.id !== null) byId.set(r.id, r)
    }
  }

  try {
    setState(readState(file) || emptyState())
  } catch {
    failed = true
  }
  let tail = Promise.resolve()

  // A throwing directory lookup must not wedge the store: it only means the
  // row is not known to be used yet.
  function used (id) {
    try {
      return isUsed(id) === true
    } catch {
      return false
    }
  }

  // One in-process queue for every write, so two issues never read the same
  // state and both write.
  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  function writable () {
    usable()
    if (readOnly) throw fail('indisponivel')
    if (!guard()) throw fail('indisponivel')
  }

  // The re-read merge every write starts from. A file this module would not
  // have written, or one that contradicts memory, marks the store unavailable.
  function reread () {
    let disk
    try {
      disk = readState(file)
    } catch {
      failed = true
      throw fail('indisponivel')
    }
    let next
    try {
      next = merge(state, disk, used)
    } catch {
      failed = true
      throw fail('indisponivel')
    }
    const stale = dirty || canonical(next) !== canonical(disk || emptyState())
    return { next, stale }
  }

  // After a failed write the file holds the previous state or `next`: merge
  // it back in (nothing acknowledged is ever dropped from memory); an
  // unreadable file marks the store unavailable. The store stays dirty, so
  // the next write rewrites before it answers.
  function persist (next) {
    try {
      writeJsonAtomic(file, toJson(next), 0o600)
    } catch (err) {
      dirty = true
      try {
        setState(merge(state, readState(file), used))
      } catch {
        failed = true
      }
      throw err
    }
    dirty = false
    setState(next)
    // The lock may have gone stale while this process stalled: this one must
    // not acknowledge. Only this request is refused; the store stays dirty.
    if (!guard()) {
      dirty = true
      throw fail('indisponivel')
    }
  }

  // Same rule as every write: the merge goes to disk whenever it differs from
  // the file (a stripped used hash, rows a replaced file lost) or the store
  // is dirty, even when the request itself writes nothing new. A failed
  // write leaves the store dirty and does not change the request's answer
  // unless the store became unusable.
  function settle (next, stale) {
    if (!stale) {
      setState(next)
      return
    }
    try {
      persist(next)
    } catch {
      usable()
    }
  }

  function weekCount (invites, member, nowMs) {
    const from = weekStart(nowMs)
    const to = from + WEEK_MS
    let n = 0
    for (const r of invites) {
      if (r.inviter !== member) continue
      const at = Date.parse(r.createdAt)
      if (at >= from && at < to) n++
    }
    return n
  }

  function issue (member) {
    return enqueue(() => {
      if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
      writable()
      if (perWeek === null) throw fail('indisponivel')
      const { next, stale } = reread()
      const nowMs = now()
      // Outside the current week AND expired: pruning never changes an
      // allowance nor invalidates a live link. A pruned id is unknown, so it
      // stays unusable.
      const from = weekStart(nowMs)
      const kept = next.invites.filter((r) => {
        const at = Date.parse(r.createdAt)
        return !(at < from && at + INVITE_TTL_MS <= nowMs)
      })
      const count = weekCount(kept, member, nowMs)
      if (count >= perWeek) {
        settle(next, stale)
        throw fail('limite-convites')
      }
      if (kept.length >= MAX_ROWS) {
        settle(next, stale)
        throw fail('limite')
      }
      const slots = new Set(kept.map((r) => r.slot))
      let code, id, slot
      do {
        code = newCode()
        id = inviteId(code)
      } while (byId.has(id) || kept.some((r) => r.id === id))
      do {
        slot = nodeCrypto.randomBytes(16).toString('hex')
      } while (slots.has(slot))
      const row = { slot, id, inviter: member, createdAt: iso(nowMs), used: false }
      persist({ v: VERSION, invites: [...kept, row].sort(byDate) })
      const usedNow = count + 1
      return {
        code,
        expiresAt: iso(nowMs + INVITE_TTL_MS),
        used: usedNow,
        remaining: perWeek - usedNow,
        resetsAt: iso(weekEnd(nowMs))
      }
    })
  }

  // One token for unknown, used and expired: the public answer never tells
  // them apart.
  function check (id) {
    if (!validId(id)) throw new TypeError('id must be 64 lowercase hex characters')
    usable()
    const r = byId.get(id)
    if (!r || r.used) return 'convite-invalido'
    if (!(now() < Date.parse(r.createdAt) + INVITE_TTL_MS)) return 'convite-invalido'
    if (used(id)) return 'convite-invalido'
    return null
  }

  // Idempotent: the link commit in the directory is the single-use authority
  // and already happened, so this only drops the hash and marks the row.
  function consume (id) {
    return enqueue(() => {
      if (!validId(id)) throw new TypeError('id must be 64 lowercase hex characters')
      writable()
      const { next, stale } = reread()
      // merge() may already have converted the row through isUsed: a slot
      // whose id vanished from the merge but exists in memory is that case.
      const row = next.invites.find((r) => r.id === id)
      if (row) {
        row.used = true
        row.id = null
        persist(next)
        return { changed: true }
      }
      const known = byId.get(id)
      if (known) {
        persist(next)
        return { changed: true }
      }
      if (stale) persist(next)
      else setState(next)
      return { changed: false }
    })
  }

  // Writes the merge of the file and memory back when the file lacks
  // anything this holder knows, the directory reports a use the file does
  // not have, or a previous write failed. True when it wrote. Never throws,
  // never writes a file it would not have written.
  function heal () {
    return enqueue(() => {
      if (failed || readOnly || !guard()) return false
      const { next, stale } = reread()
      if (stale) {
        persist(next)
        return true
      }
      setState(next)
      return false
    }).catch(() => false)
  }

  function summary (member) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
    usable()
    if (perWeek === null) return null
    const nowMs = now()
    const usedNow = weekCount(state.invites, member, nowMs)
    return { perWeek, used: usedNow, remaining: Math.max(0, perWeek - usedNow), resetsAt: iso(weekEnd(nowMs)) }
  }

  function count () {
    usable()
    let n = 0
    for (const r of state.invites) {
      if (r.used) n++
    }
    return { total: state.invites.length, used: n }
  }

  const store = {
    issue,
    check,
    consume,
    heal,
    summary,
    count,
    fail () { failed = true },
    available () { return !failed }
  }
  Object.defineProperty(store, 'perWeek', { value: perWeek, enumerable: true, writable: false })
  return store
}

module.exports = {
  openInvitesStore,
  FILE,
  CODE_RE,
  WEEK_MS,
  INVITE_TTL_MS,
  MAX_ROWS,
  PER_WEEK_MAX,
  newCode,
  inviteId,
  weekStart,
  weekEnd
}
