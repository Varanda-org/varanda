'use strict'

// Native registrations live in their own sidecar so Web Push and older builds
// keep opening the same data directory. Opening never writes; readOnly never
// writes either. Unknown file shapes fail closed and are never rewritten.
// Tokens and keys must never appear in logs or errors.
//
// As in push-store.js, queued writes re-read and merge disk with memory before
// writeGuarded atomically replaces the mode-0600 file. The latest createdAt
// wins, first per member+key, then per transport+token; ties keep memory.
// Each member keeps its newest four rows. Admission alone caps member count,
// since healing after a takeover may need to preserve a larger union.
//
// Generations advance beyond all known rows of the member, the token's owner
// and relevant tombstones even if the clock moves back. A rotation therefore
// beats its stale copy and a newly added row survives the per-member cap.
// Removed, moved, replaced and evicted rows leave member+key tombstones with
// their generation for this process's lifetime (bounded FIFO). They suppress
// stale disk rows, but allow strictly newer registrations. Healing retains
// tombstones so repeated late renames cannot resurrect a removed device.
//
// Memory and tombstones change only after persistence and a final guard check.
// A refusal before rename leaves disk untouched; losing the lock after rename
// never acknowledges the write. Failed writes stay dirty until a later merge
// is written. guard() refusal affects only that request, while fail() and a
// malformed file make the store unavailable. Another holder's removals cannot
// be inferred from a missing row: a retained row may cost one failed push,
// which removeToken discards only if the member still holds that exact token.

const fs = require('node:fs')
const path = require('node:path')
const { writeGuarded, isRefused } = require('./guarded-write')
const { isLowerHex, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'push-devices.json'
const VERSION = 1
const PUSH_DEVICE_MAX_PER_MEMBER = 4
const MAX_MEMBERS = 100000
const TOMBSTONE_MAX = 10000
const ROW_KEYS = ['transport', 'token', 'key', 'createdAt']

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

function validTransport (transport) {
  return transport === 'apns' || transport === 'fcm'
}

function validToken (transport, token) {
  if (typeof token !== 'string') return false
  if (transport === 'apns') return token.length >= 64 && token.length <= 200 && !/[^0-9a-f]/.test(token)
  if (transport === 'fcm') return token.length >= 1 && token.length <= 4096 && !/[^A-Za-z0-9_:-]/.test(token)
  return false
}

function validKey (key) {
  if (typeof key !== 'string' || key.length !== 22 || /[^A-Za-z0-9_-]/.test(key)) return false
  const bytes = Buffer.from(key, 'base64url')
  return bytes.length === 16 && bytes.toString('base64url') === key
}

function validRow (row) {
  return isPlainObject(row) && exactKeys(row, ROW_KEYS) &&
    validTransport(row.transport) && validToken(row.transport, row.token) &&
    validKey(row.key) && Number.isSafeInteger(row.createdAt)
}

function byDate (a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function copyRow (row) {
  return { transport: row.transport, token: row.token, key: row.key, createdAt: row.createdAt }
}

function tokenKey (row) {
  return row.transport + ' ' + row.token
}

function emptyState () {
  return { v: VERSION, members: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'members']) || obj.v !== VERSION) throw new Error('inscrições inválidas')
  if (!isPlainObject(obj.members)) throw new Error('inscrições inválidas')
  // No member-count ceiling here, as in terms-store.js: a heal after a
  // takeover may write a merge past MAX_MEMBERS, which only limits add().
  const state = emptyState()
  const seen = new Set()
  for (const [member, list] of Object.entries(obj.members)) {
    // This store never writes a member without a subscription.
    if (!validMember(member) || !Array.isArray(list) || list.length === 0 || list.length > PUSH_DEVICE_MAX_PER_MEMBER) throw new Error('inscrições inválidas')
    const keys = new Set()
    for (const r of list) {
      if (!validRow(r) || keys.has(r.key) || seen.has(tokenKey(r))) throw new Error('inscrições inválidas')
      keys.add(r.key)
      seen.add(tokenKey(r))
    }
    state.members[member] = list.map(copyRow).sort(byDate)
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
  if (!st.isFile()) throw new Error('inscrições inválidas')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function toJson (state) {
  const members = {}
  for (const member of Object.keys(state.members).sort()) {
    members[member] = state.members[member].map(copyRow)
  }
  return { v: VERSION, members }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

function tombKey (member, key) {
  return member + ' ' + key
}

function burial (member, row) {
  return [member, row.key, row.createdAt]
}

function cap (member, list) {
  list.sort(byDate)
  return list.splice(0, Math.max(0, list.length - PUSH_DEVICE_MAX_PER_MEMBER)).map((r) => burial(member, r))
}

// Resolve rotations before token ownership so a stale token cannot displace
// the current row of the same device. Every loser is buried, including rows
// lost during a merge, so it cannot return after the winning row is removed.
function merge (mem, disk, tombs) {
  const devices = new Map()
  const evicted = []
  function adopt (map, id, candidate) {
    const cur = map.get(id)
    if (!cur) {
      map.set(id, candidate)
      return
    }
    if (cur.member === candidate.member && cur.row.key === candidate.row.key &&
        cur.row.createdAt === candidate.row.createdAt && tokenKey(cur.row) === tokenKey(candidate.row)) return
    const wins = candidate.row.createdAt > cur.row.createdAt ||
      (candidate.row.createdAt === cur.row.createdAt && candidate.memory && !cur.memory)
    const loser = wins ? cur : candidate
    evicted.push(burial(loser.member, loser.row))
    if (wins) map.set(id, candidate)
  }
  for (const [source, memory] of [[mem, true], [disk, false]]) {
    if (!source) continue
    for (const [member, rows] of Object.entries(source.members)) {
      for (const row of rows) {
        const id = tombKey(member, row.key)
        const g = tombs.get(id)
        if (!memory && g !== undefined && g >= row.createdAt) continue
        adopt(devices, id, { member, row, memory })
      }
    }
  }
  const owners = new Map()
  for (const candidate of devices.values()) adopt(owners, tokenKey(candidate.row), candidate)
  const next = emptyState()
  for (const { member, row } of owners.values()) {
    if (!next.members[member]) next.members[member] = []
    next.members[member].push(copyRow(row))
  }
  for (const [member, rows] of Object.entries(next.members)) evicted.push(...cap(member, rows))
  return { next, evicted }
}

function findToken (state, transport, token) {
  for (const [member, rows] of Object.entries(state.members)) {
    const row = rows.find((r) => r.transport === transport && r.token === token)
    if (row) return { member, row }
  }
  return null
}

function openPushDeviceStore (dataDir, { now = Date.now, readOnly = false, guard = () => true } = {}) {
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
  // member+key -> createdAt of the row it buried. Insertion order is
  // the FIFO order; a re-buried key moves to the end.
  const tombs = new Map()
  let tail = Promise.resolve()

  function commitTombs (buried) {
    for (const [member, deviceKey, createdAt] of buried) {
      const key = tombKey(member, deviceKey)
      const prev = tombs.get(key)
      tombs.delete(key)
      tombs.set(key, prev !== undefined && prev > createdAt ? prev : createdAt)
    }
    while (tombs.size > TOMBSTONE_MAX) tombs.delete(tombs.keys().next().value)
  }

  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  // `next` and `buried` are candidates: memory and tombstones change only
  // once the write landed and guard() still answers true, so a refused or
  // failed request leaves both exactly as they were. The file may still hold
  // `next` after a failure; the store stays dirty, so the next write or heal
  // merges and rewrites before it answers. An unreadable file marks the
  // store unavailable. A refusal right before the rename left the file
  // untouched, so the store does not turn dirty.
  function persist (next, buried) {
    try {
      writeGuarded(file, toJson(next), 0o600, guard)
    } catch (err) {
      if (isRefused(err)) throw fail('indisponivel')
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
    commitTombs(buried)
  }

  // Re-reads the file and returns the merge, the rows its cap evicted and
  // whether it must be written even when this request changes nothing.
  function reread () {
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
    const { next, evicted } = merge(state, disk, tombs)
    return { next, evicted, stale: dirty || canonical(next) !== canonical(disk || emptyState()) }
  }

  // Not persisting means `next` equals the disk: adopt it so list() and
  // count() see it. What the merge evicted is already absent from the file.
  function settle (next, evicted, stale) {
    if (stale) return persist(next, evicted)
    state = next
    commitTombs(evicted)
  }

  function freshDate (next, buried, member, row) {
    let hi = -Infinity
    const see = (ms) => { if (ms > hi) hi = ms }
    for (const r of next.members[member] || []) see(r.createdAt)
    const found = findToken(next, row.transport, row.token)
    if (found) see(found.row.createdAt)
    const g = tombs.get(tombKey(member, row.key))
    if (g !== undefined) see(g)
    for (const [m, k, c] of buried) if (m === member && k === row.key) see(c)
    const createdAt = Math.max(now(), row.createdAt, hi + 1)
    if (!Number.isSafeInteger(createdAt)) throw fail('indisponivel')
    return createdAt
  }

  function checkMember (member) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
  }

  function add (member, row) {
    // Snapshot before enqueueing so a caller cannot change a queued request.
    const input = validRow(row) ? copyRow(row) : null
    return enqueue(() => {
      checkMember(member)
      if (!input) throw new TypeError('invalid device row')
      const { next, evicted, stale } = reread()
      const own = (next.members[member] || []).find((r) => r.key === input.key)
      if (own && own.transport === input.transport && own.token === input.token) {
        settle(next, evicted, stale)
        return { changed: false }
      }
      const found = findToken(next, input.transport, input.token)
      // Admission counts members after the transfer, as in push-store.js.
      const leaving = found && found.member !== member && next.members[found.member].length === 1 ? 1 : 0
      if (!next.members[member] && Object.keys(next.members).length - leaving >= MAX_MEMBERS) {
        settle(next, evicted, stale)
        throw fail('limite')
      }
      const buried = evicted.slice()
      const createdAt = freshDate(next, buried, member, input)
      for (const old of [own && { member, row: own }, found]) {
        if (!old) continue
        const rows = next.members[old.member]
        const i = rows.indexOf(old.row)
        rows.splice(i, 1)
        if (rows.length === 0) delete next.members[old.member]
        buried.push(burial(old.member, old.row))
      }
      const rows = next.members[member] || []
      rows.push({ ...input, createdAt })
      buried.push(...cap(member, rows))
      next.members[member] = rows
      persist(next, buried)
      return { changed: true }
    })
  }

  function removeMatching (member, matches) {
    const { next, evicted, stale } = reread()
    const rows = next.members[member] || []
    const i = rows.findIndex(matches)
    if (i === -1) {
      settle(next, evicted, stale)
      return false
    }
    const [old] = rows.splice(i, 1)
    if (rows.length === 0) delete next.members[member]
    persist(next, [...evicted, burial(member, old)])
    return true
  }

  function remove (member, key) {
    return enqueue(() => {
      checkMember(member)
      if (!validKey(key)) throw new TypeError('invalid device key')
      return { changed: removeMatching(member, (r) => r.key === key) }
    })
  }

  function removeToken (member, transport, token) {
    return enqueue(() => {
      checkMember(member)
      if (!validToken(transport, token)) throw new TypeError('invalid device token')
      return removeMatching(member, (r) => r.transport === transport && r.token === token)
    })
  }

  function removeMember (member) {
    return enqueue(() => {
      checkMember(member)
      const { next, evicted, stale } = reread()
      const list = next.members[member]
      if (!list) {
        settle(next, evicted, stale)
        return { changed: false }
      }
      delete next.members[member]
      persist(next, [...evicted, ...list.map((r) => burial(member, r))])
      return { changed: true }
    })
  }

  // Writes the merge of the file and memory back when they differ (a stale
  // writer's rename may have dropped acknowledged rows or restored removed
  // ones) or a previous write failed. True when it wrote. Never throws,
  // never writes a file it would not have written.
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
      const { next, evicted } = merge(state, disk, tombs)
      if (dirty || canonical(next) !== canonical(disk || emptyState())) {
        persist(next, evicted)
        return true
      }
      state = next
      commitTombs(evicted)
      return false
    }).catch(() => false)
  }

  function list (member) {
    checkMember(member)
    usable()
    return (state.members[member] || []).map(copyRow)
  }

  function all () {
    usable()
    const seen = new Set()
    const out = []
    for (const [member, rows] of Object.entries(state.members)) {
      for (const row of rows) {
        const id = tokenKey(row)
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ member, ...copyRow(row) })
      }
    }
    return out
  }

  function devices (member) {
    checkMember(member)
    usable()
    return (state.members[member] || []).length
  }

  function count () {
    usable()
    let n = 0
    for (const rows of Object.values(state.members)) n += rows.length
    return n
  }

  return {
    add,
    remove,
    removeToken,
    removeMember,
    heal,
    list,
    all,
    devices,
    count,
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openPushDeviceStore,
  FILE,
  PUSH_DEVICE_MAX_PER_MEMBER,
  MAX_MEMBERS,
  TOMBSTONE_MAX,
  validTransport,
  validToken,
  validKey
}
