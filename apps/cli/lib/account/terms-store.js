'use strict'

// The acceptances of the Termos de Uso and the Política de Privacidade the
// account service has recorded: for each member key, the versions it
// accepted, when, and the signed request (nonce, signature) that proved it.
// ONE sidecar file, <dataDir>/terms.json (mode 0o600), always replaced whole
// through writeJsonAtomic (packages/core/lib/store.js: O_EXCL temp, fsync,
// rename, dir fsync). It is NOT part of account/store.js on purpose: that
// store's applyEntry throws on an op it does not know and it only scans
// directory.journal.* names, so a separate file keeps older and newer builds
// able to open the same data dir. Never an e-mail, a sub or a username here.
//
// Opening never creates, mkdirs or chmods anything (a missing file means no
// acceptance yet; the first accept writes it), and a readOnly store never
// writes at all. Validation is total: a file this module would not have
// written (bad JSON, unknown keys, a bad member or entry, a duplicate
// version, too many entries) is never rewritten, and every method then
// throws { code: 'indisponivel' } until an operator repairs it. Errors carry
// only a token in `code`; bad argument shapes throw TypeError.
//
// Every accept runs in one in-process queue against a copy of the state and
// first re-reads the file: the service lock goes stale after 30 s
// (account/server.js LOCK_STALE_MS) and writeJsonAtomic renames
// unconditionally, so another holder may have replaced the file meanwhile.
// Disk and memory are union-merged (per member and version the earliest
// acceptedAt wins) and the merge is written whenever it differs from the
// file, an entry is new, or a previous write failed ('dirty'), so no answer
// relies on a write whose fsync failed. The state is swapped only after the
// write returned, and guard() is asked again afterwards: a holder that lost
// the lock meanwhile does not acknowledge.
//
// guard() === false (before or after the write) refuses THAT request only
// ({ code: 'indisponivel' }): lock.owned() also answers false on a transient
// read error of the lock file, so it never wedges the store. A refusal after
// the write leaves the store dirty, so the next accept or heal merge-writes
// before it answers. The store becomes unavailable for good only through
// fail() (the heartbeat confirmed the lock is lost) or a malformed file.
//
// heal() runs in the same queue: it re-reads the file, union-merges it with
// memory and writes the merge back when the file lacks anything this holder
// knows (or the store is dirty). The service calls it on the lock heartbeat's
// interval and once on a clean stop.
//
// Remaining window, inherent without OS file locks: the guard and the rename
// are separate syscalls, so a stalled writer's rename can still land after a
// takeover and replace the new holder's file. That write is never
// acknowledged (the re-guard refuses it, the client keeps its pending
// acceptance and retries), and whatever it dropped from the new holder's
// file is written back within one heal interval by the current holder (or on
// its clean stop), since the holder keeps everything it acknowledged in
// memory. What remains is a crash of the holder inside that interval.

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'terms.json'
const VERSION = 1
const MAX_PER_MEMBER = 32
const MAX_MEMBERS = 100000
const MAX_TERMS_VERSION = 9999
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const SIGNATURE_RE = /^[0-9a-f]{128}$/
const ENTRY_KEYS = ['version', 'acceptedAt', 'nonce', 'signature']

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

function validVersion (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= MAX_TERMS_VERSION
}

function validNonce (n) {
  return typeof n === 'string' && NONCE_RE.test(n)
}

function validSignature (s) {
  return typeof s === 'string' && SIGNATURE_RE.test(s)
}

function validEntry (e) {
  return isPlainObject(e) &&
    exactKeys(e, ENTRY_KEYS) &&
    validVersion(e.version) &&
    isCanonicalIso(e.acceptedAt) &&
    validNonce(e.nonce) &&
    validSignature(e.signature)
}

// Oldest first; ties by version so the order never depends on the source.
function byDate (a, b) {
  if (a.acceptedAt !== b.acceptedAt) return a.acceptedAt < b.acceptedAt ? -1 : 1
  return a.version - b.version
}

function copyEntry (e) {
  return { version: e.version, acceptedAt: e.acceptedAt, nonce: e.nonce, signature: e.signature }
}

function emptyState () {
  return { v: VERSION, members: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'members']) || obj.v !== VERSION) throw new Error('termos inválidos')
  if (!isPlainObject(obj.members)) throw new Error('termos inválidos')
  // No member-count ceiling here: MAX_MEMBERS only limits admissions in
  // accept(). A heal after a takeover writes the union of two valid copies,
  // which may pass it, and a load-time ceiling would make this store refuse a
  // file it wrote itself.
  const state = emptyState()
  for (const [member, list] of Object.entries(obj.members)) {
    // This store never writes a member without an acceptance.
    if (!validMember(member) || !Array.isArray(list) || list.length === 0 || list.length > MAX_PER_MEMBER) throw new Error('termos inválidos')
    const seen = new Set()
    for (const e of list) {
      if (!validEntry(e) || seen.has(e.version)) throw new Error('termos inválidos')
      seen.add(e.version)
    }
    state.members[member] = list.map(copyEntry).sort(byDate)
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
  if (!st.isFile()) throw new Error('termos inválidos')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function toJson (state) {
  const members = {}
  for (const member of Object.keys(state.members).sort()) {
    members[member] = state.members[member].map(copyEntry)
  }
  return { v: VERSION, members }
}

// Comparable form: members sorted, entries already oldest first.
function canonical (state) {
  return JSON.stringify(toJson(state))
}

// The per-member cap keeps the highest versions, never the latest dates: the
// clock may go backwards, versions only go up, and accept() and merge() must
// agree on what is kept or a merge would drop an acknowledged acceptance.
function capped (list) {
  if (list.length <= MAX_PER_MEMBER) return list
  return [...list].sort((a, b) => b.version - a.version).slice(0, MAX_PER_MEMBER).sort(byDate)
}

// Union of the in-memory state and the file: per member and version the
// entry with the earliest acceptedAt (ties keep the in-memory one), then the
// per-member cap drops the lowest versions.
function merge (mem, disk) {
  const out = emptyState()
  const members = new Set(Object.keys(mem.members))
  if (disk) for (const m of Object.keys(disk.members)) members.add(m)
  for (const member of members) {
    const byVersion = new Map()
    for (const e of mem.members[member] || []) byVersion.set(e.version, e)
    for (const e of (disk && disk.members[member]) || []) {
      const cur = byVersion.get(e.version)
      if (!cur || e.acceptedAt < cur.acceptedAt) byVersion.set(e.version, e)
    }
    out.members[member] = capped([...byVersion.values()].map(copyEntry).sort(byDate))
  }
  return out
}

function memberCount (state) {
  let n = 0
  for (const list of Object.values(state.members)) {
    if (list.length > 0) n++
  }
  return n
}

function openTermsStore (dataDir, { now = Date.now, readOnly = false, guard = () => true } = {}) {
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

  // One in-process queue for every write, so two accepts never read the same
  // state and both write.
  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  // After a failed write the file holds the previous state or `next`: merge
  // it back in (nothing acknowledged is ever dropped from memory); an
  // unreadable file marks the store unavailable. The store stays dirty, so
  // the next accept rewrites before it answers.
  function persist (next) {
    try {
      writeJsonAtomic(file, toJson(next), 0o600)
    } catch (err) {
      dirty = true
      try {
        state = merge(state, readState(file))
      } catch {
        failed = true
      }
      throw err
    }
    dirty = false
    state = next
    // The lock may have gone stale while this process stalled (or its read
    // failed transiently): this one must not acknowledge. Only this request
    // is refused; the store stays dirty, so the next accept or heal rewrites
    // the merge before it answers.
    if (!guard()) {
      dirty = true
      throw fail('indisponivel')
    }
  }

  function accept ({ member, version, nonce, signature } = {}) {
    return enqueue(() => {
      if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
      if (!validVersion(version)) throw new TypeError('version must be an integer from 1 to ' + MAX_TERMS_VERSION)
      if (!validNonce(nonce)) throw new TypeError('invalid nonce')
      if (!validSignature(signature)) throw new TypeError('signature must be 128 lowercase hex characters')
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
      const next = merge(state, disk)
      const stale = dirty || canonical(next) !== canonical(disk || emptyState())
      const list = next.members[member] || []
      const existing = list.find((e) => e.version === version)
      if (existing) {
        // Not persisting means `next` equals the disk: adopt it so list()
        // and count() see it and a later external replacement is healed.
        if (stale) persist(next)
        else state = next
        return { version, acceptedAt: existing.acceptedAt, changed: false }
      }
      if (list.length === 0 && memberCount(next) >= MAX_MEMBERS) {
        if (stale) persist(next)
        else state = next
        throw fail('limite')
      }
      const entry = { version, acceptedAt: new Date(now()).toISOString(), nonce, signature }
      // Same cap as merge(): an acceptance the cap would drop (a version
      // below all MAX_PER_MEMBER kept ones) is refused, never acknowledged.
      const kept = capped([...list, entry].sort(byDate))
      if (!kept.includes(entry)) {
        if (stale) persist(next)
        else state = next
        throw fail('limite')
      }
      next.members[member] = kept
      persist(next)
      return { version, acceptedAt: entry.acceptedAt, changed: true }
    })
  }

  // Writes the merge of the file and memory back when the file lacks
  // anything this holder knows (a stale writer's rename may have dropped
  // acknowledged entries) or a previous write failed. True when it wrote.
  // Never throws, never writes a file it would not have written.
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

  function list (member) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
    usable()
    return (state.members[member] || []).map((e) => ({ version: e.version, acceptedAt: e.acceptedAt }))
  }

  function count () {
    usable()
    return memberCount(state)
  }

  return {
    accept,
    heal,
    list,
    count,
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openTermsStore,
  FILE,
  MAX_PER_MEMBER,
  MAX_MEMBERS
}
