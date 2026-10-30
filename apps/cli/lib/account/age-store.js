'use strict'

// The age bands the account service has verified: for each member key, the
// band ('16-17' or '18+'), the method that checked it and when. ONE sidecar
// file, <dataDir>/age.json (mode 0o600), always replaced whole through
// writeJsonAtomic (packages/core/lib/store.js), kept apart from
// account/store.js for the same reason as terms.json. Only these three
// fields, ever: no session id, age, birth date, name, image, URL, IP or raw
// vendor answer.
//
// Opening never creates, mkdirs or chmods anything (a missing file means
// nobody is verified yet) and a readOnly store never writes. Validation is
// total: a file this module would not have written is never rewritten, and
// every method then throws { code: 'indisponivel' } until an operator
// repairs it. Bad argument shapes throw TypeError.
//
// Every write runs in one in-process queue and first re-reads the file (the
// service lock can go stale and writeJsonAtomic renames unconditionally), so
// memory and disk are union-merged: per member the earliest checkedAt wins
// and, on a tie, the more protective '16-17'. A later '18+' never replaces a
// '16-17'.
//
// Unlike terms-store, memory holds only what was durably written: a record()
// whose write throws, or whose guard() refuses after the write, leaves the
// in-memory state as it was, so verified() never answers true for an entry
// that may not be on disk. The store is then marked dirty, which only forces
// the next record or heal to rewrite the merge before answering; an entry
// the failed write did land is adopted from the file on that re-read.
//
// heal() runs in the same queue: it re-reads the file and writes the merge
// back when the file lacks anything this holder knows (or the store is
// dirty). The service calls it through startHeal (commands/account.js).

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'age.json'
const VERSION = 1
const BANDS = Object.freeze(['16-17', '18+'])
const METHODS = Object.freeze(['didit'])
const ENTRY_KEYS = ['band', 'method', 'checkedAt']

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

function validEntry (e) {
  return isPlainObject(e) &&
    exactKeys(e, ENTRY_KEYS) &&
    BANDS.includes(e.band) &&
    METHODS.includes(e.method) &&
    isCanonicalIso(e.checkedAt)
}

function copyEntry (e) {
  return { band: e.band, method: e.method, checkedAt: e.checkedAt }
}

function emptyState () {
  return { v: VERSION, members: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'members']) || obj.v !== VERSION) throw new Error('idade inválida')
  if (!isPlainObject(obj.members)) throw new Error('idade inválida')
  const state = emptyState()
  for (const [member, entry] of Object.entries(obj.members)) {
    if (!validMember(member) || !validEntry(entry)) throw new Error('idade inválida')
    state.members[member] = copyEntry(entry)
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
  if (!st.isFile()) throw new Error('idade inválida')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function toJson (state) {
  const members = {}
  for (const member of Object.keys(state.members).sort()) {
    members[member] = copyEntry(state.members[member])
  }
  return { v: VERSION, members }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

// Which of two records for one member is kept: the earlier one; on a tie the
// more protective band, so the result never depends on the source.
function pick (a, b) {
  if (a.checkedAt !== b.checkedAt) return a.checkedAt < b.checkedAt ? a : b
  if (a.band === b.band) return a
  return a.band === '16-17' ? a : b
}

function merge (mem, disk) {
  const out = emptyState()
  for (const [member, e] of Object.entries(mem.members)) out.members[member] = copyEntry(e)
  if (disk) {
    for (const [member, e] of Object.entries(disk.members)) {
      const cur = out.members[member]
      out.members[member] = copyEntry(cur ? pick(cur, e) : e)
    }
  }
  return out
}

function openAgeStore (dataDir, { now = Date.now, guard = () => true, readOnly = false } = {}) {
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, FILE)
  let state = emptyState()
  let failed = false
  let dirty = false
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

  // `state` changes only after the write returned and guard() still holds.
  // On a write failure memory keeps the previous durable state (an
  // unreadable file afterwards marks the store unavailable); the next write
  // re-reads the file, so whatever did land is adopted then.
  function persist (next) {
    try {
      writeJsonAtomic(file, toJson(next), 0o600)
    } catch {
      dirty = true
      try {
        readState(file)
      } catch {
        failed = true
      }
      throw fail('indisponivel')
    }
    if (!guard()) {
      dirty = true
      throw fail('indisponivel')
    }
    dirty = false
    state = next
  }

  function record ({ member, band, method, checkedAt } = {}) {
    return enqueue(() => {
      if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
      if (!BANDS.includes(band)) throw new TypeError('band must be one of ' + BANDS.join(', '))
      if (!METHODS.includes(method)) throw new TypeError('method must be one of ' + METHODS.join(', '))
      const at = checkedAt === undefined ? new Date(now()).toISOString() : checkedAt
      if (!isCanonicalIso(at)) throw new TypeError('checkedAt must be a canonical ISO date')
      usable()
      if (readOnly) throw fail('indisponivel')
      if (!guard()) throw fail('indisponivel')
      let disk
      try {
        disk = readState(file)
      } catch {
        failed = true
        throw fail('indisponivel')
      }
      const base = merge(state, disk)
      const stale = dirty || canonical(base) !== canonical(disk || emptyState())
      const entry = { band, method, checkedAt: at }
      const cur = base.members[member]
      const kept = cur ? pick(cur, entry) : entry
      if (kept !== entry) {
        // `base` equals the disk when not stale, so adopting it keeps memory
        // to durable entries only.
        if (stale) persist(base)
        else state = base
        return { changed: false }
      }
      const next = merge(base, emptyState())
      next.members[member] = copyEntry(entry)
      persist(next)
      return { changed: true }
    })
  }

  // True when it wrote. Never throws, never writes a file it would not have
  // written.
  function heal () {
    return enqueue(() => {
      if (failed || readOnly || !guard()) return false
      let disk
      try {
        disk = readState(file)
      } catch {
        failed = true
        return false
      }
      const next = merge(state, disk)
      if (dirty || canonical(next) !== canonical(disk || emptyState())) {
        persist(next)
        return true
      }
      state = next
      return false
    }).catch(() => false)
  }

  function get (member) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
    usable()
    const e = state.members[member]
    return e ? copyEntry(e) : null
  }

  function verified (member) {
    return get(member) !== null
  }

  return {
    record,
    get,
    verified,
    heal,
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openAgeStore,
  FILE,
  BANDS,
  METHODS
}
