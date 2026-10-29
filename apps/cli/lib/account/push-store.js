'use strict'

// The Web Push subscriptions the account service holds: for each member key,
// up to PUSH_MAX_PER_MEMBER browser subscriptions (endpoint and the two
// RFC 8291 keys). ONE sidecar file, <dataDir>/push.json (mode 0o600), always
// replaced whole through writeJsonAtomic (packages/core/lib/store.js: O_EXCL
// temp, fsync, rename, dir fsync). It is NOT part of account/store.js for the
// same reason as terms-store.js: older and newer builds must keep opening
// the same data dir. Never an e-mail, a sub or a username here, and nothing
// from this file is logged: an endpoint is a capability URL.
//
// Opening never creates, mkdirs or chmods anything (a missing file means no
// subscription yet; the first put writes it), and a readOnly store never
// writes at all. Validation is total: a file this module would not have
// written (bad JSON, unknown keys, a bad member or row, an endpoint stored
// twice, too many rows) is never rewritten, and every method then throws
// { code: 'indisponivel' } until an operator repairs it. Errors carry only a
// token in `code`; bad argument shapes throw TypeError. The push-service host
// allowlist is not checked here: the route and sendPush own it, so a change
// to the list never makes a stored file invalid.
//
// Every write runs in one in-process queue against a copy of the state and
// first re-reads the file: the service lock goes stale after 30 s
// (account/server.js LOCK_STALE_MS) and writeJsonAtomic renames
// unconditionally, so another holder may have replaced the file meanwhile.
// Disk and memory are merged (per endpoint the latest createdAt wins, ties
// keep memory, then each member keeps its newest PUSH_MAX_PER_MEMBER rows)
// and the merge is written whenever it differs from the file or a previous
// write failed ('dirty'). Memory and tombstones change only after the write
// returned and guard() answered true again: a holder that lost the lock
// meanwhile does not acknowledge, and a refused or failed request leaves both
// as they were. guard() === false refuses that request only; fail() and a
// malformed file make the store unavailable for good.
//
// Every row a write creates or updates gets createdAt = max(now, the latest
// createdAt known for that member or endpoint + 1 ms). With a clock that went
// back, an acknowledged update still beats the stale copy it replaces, and a
// new row is always its member's newest, so the cap never drops it.
//
// Unlike terms.json, rows are also removed. A plain union would bring back
// a row this process removed whenever the file still holds it, and a stalled
// writer's rename can land after a takeover with an old copy (terms-store.js
// documents that window). So every member+endpoint this process removed,
// moved away (in a put, or a merge that gave the endpoint to another member)
// or evicted by the cap (in a put or in any merge) is kept as a
// tombstone with the createdAt of the row it buried, for the whole life of
// the process (bounded FIFO, TOMBSTONE_MAX). A re-read drops a disk row only
// when its tombstone is of the same or a later generation; a strictly newer
// row is a later registration (another holder, or the member turning push
// back on) and is merged normally. Clearing tombstones on heal() would let
// that late rename resurrect a removed subscription. Removals made by another
// holder are not known here: a row it removed that this holder still has in
// memory is written back, which costs one failed push (the service drops a
// subscription the push service answers 404 or 410 for).

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'push.json'
const VERSION = 1
const PUSH_MAX_PER_MEMBER = 4
const MAX_MEMBERS = 100000
const ENDPOINT_MAX = 2048
const TOMBSTONE_MAX = 10000
const P256DH_BYTES = 65
const AUTH_BYTES = 16
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const ROW_KEYS = ['endpoint', 'p256dh', 'auth', 'createdAt']

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

// The URL parser silently strips tabs and newlines and accepts "https://@h",
// so the raw string is checked as well as the parsed one.
function validEndpoint (e) {
  if (typeof e !== 'string' || e.length === 0 || e.length > ENDPOINT_MAX) return false
  if (/[\s\x00-\x1f\x7f]/.test(e) || e.includes('#')) return false // eslint-disable-line no-control-regex
  const authority = /^https:\/\/([^/?]*)/.exec(e)
  if (!authority || authority[1].includes('@')) return false
  let url
  try {
    url = new URL(e)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '' && url.hostname !== ''
}

// Unpadded, canonical base64url of exactly `bytes` bytes.
function decodeKey (s, bytes) {
  if (typeof s !== 'string' || s.length !== Math.ceil(bytes * 4 / 3) || !B64URL_RE.test(s)) return null
  const buf = Buffer.from(s, 'base64url')
  if (buf.length !== bytes || buf.toString('base64url') !== s) return null
  return buf
}

function validP256dh (s) {
  const buf = decodeKey(s, P256DH_BYTES)
  return buf !== null && buf[0] === 0x04
}

function validAuth (s) {
  return decodeKey(s, AUTH_BYTES) !== null
}

function validRow (r) {
  return isPlainObject(r) &&
    exactKeys(r, ROW_KEYS) &&
    validEndpoint(r.endpoint) &&
    validP256dh(r.p256dh) &&
    validAuth(r.auth) &&
    isCanonicalIso(r.createdAt)
}

// Oldest first; ties by endpoint so the order never depends on the source.
function byDate (a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0
}

function copyRow (r) {
  return { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: r.createdAt }
}

function emptyState () {
  return { v: VERSION, members: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'members']) || obj.v !== VERSION) throw new Error('inscrições inválidas')
  if (!isPlainObject(obj.members)) throw new Error('inscrições inválidas')
  // No member-count ceiling here, as in terms-store.js: a heal after a
  // takeover may write a merge past MAX_MEMBERS, which only limits put().
  const state = emptyState()
  const seen = new Set()
  for (const [member, list] of Object.entries(obj.members)) {
    // This store never writes a member without a subscription.
    if (!validMember(member) || !Array.isArray(list) || list.length === 0 || list.length > PUSH_MAX_PER_MEMBER) throw new Error('inscrições inválidas')
    for (const r of list) {
      if (!validRow(r) || seen.has(r.endpoint)) throw new Error('inscrições inválidas')
      seen.add(r.endpoint)
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

function tombKey (member, endpoint) {
  return member + ' ' + endpoint
}

// Keeps a member's newest PUSH_MAX_PER_MEMBER rows by byDate. put() and
// merge() share it so a cap applied in either place drops the same rows.
// Returns the dropped rows as [member, endpoint, createdAt] burials.
function cap (member, list) {
  list.sort(byDate)
  const cut = Math.max(0, list.length - PUSH_MAX_PER_MEMBER)
  return list.splice(0, cut).map((r) => [member, r.endpoint, r.createdAt])
}

// Memory and the file: a disk row whose member+endpoint has a tombstone of
// the same or a later generation (createdAt) is dropped; a strictly newer one
// is a later registration and stays. Then one owner per endpoint (the latest
// createdAt, ties keep memory) and the per-member cap. The row of the member
// that loses an endpoint is buried too: otherwise, once the winner removes
// it, a stale copy of the loser's row would deliver to that member again.
function merge (mem, disk, tombs) {
  const owner = new Map()
  const evicted = []
  for (const [member, list] of Object.entries(mem.members)) {
    for (const r of list) owner.set(r.endpoint, { member, row: r })
  }
  if (disk) {
    for (const [member, list] of Object.entries(disk.members)) {
      for (const r of list) {
        const g = tombs.get(tombKey(member, r.endpoint))
        if (g !== undefined && g >= r.createdAt) continue
        const cur = owner.get(r.endpoint)
        const wins = !cur || r.createdAt > cur.row.createdAt
        if (cur && cur.member !== member) {
          evicted.push(wins ? [cur.member, r.endpoint, cur.row.createdAt] : [member, r.endpoint, r.createdAt])
        }
        if (wins) owner.set(r.endpoint, { member, row: r })
      }
    }
  }
  const out = emptyState()
  for (const { member, row } of owner.values()) {
    if (!out.members[member]) out.members[member] = []
    out.members[member].push(copyRow(row))
  }
  for (const [member, list] of Object.entries(out.members)) evicted.push(...cap(member, list))
  return { next: out, evicted }
}

function findEndpoint (state, endpoint) {
  for (const [member, list] of Object.entries(state.members)) {
    const i = list.findIndex((r) => r.endpoint === endpoint)
    if (i !== -1) return { member, i }
  }
  return null
}

function openPushStore (dataDir, { now = Date.now, readOnly = false, guard = () => true } = {}) {
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
  // member+endpoint -> createdAt of the row it buried. Insertion order is
  // the FIFO order; a re-buried key moves to the end.
  const tombs = new Map()
  let tail = Promise.resolve()

  function commitTombs (buried) {
    for (const [member, endpoint, createdAt] of buried) {
      const key = tombKey(member, endpoint)
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
  // store unavailable.
  function persist (next, buried) {
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

  // Later than every row and tombstone of this member+endpoint and every
  // row of the member, whatever the clock says: an acknowledged write then
  // beats any stale copy and is never the row the member cap drops.
  function freshDate (next, buried, member, endpoint) {
    let hi = -Infinity
    const see = (iso) => { const ms = Date.parse(iso); if (ms > hi) hi = ms }
    for (const r of next.members[member] || []) see(r.createdAt)
    const found = findEndpoint(next, endpoint)
    if (found) see(next.members[found.member][found.i].createdAt)
    const g = tombs.get(tombKey(member, endpoint))
    if (g !== undefined) see(g)
    for (const [m, e, c] of buried) if (m === member && e === endpoint) see(c)
    return new Date(Math.max(now(), hi + 1)).toISOString()
  }

  function checkMember (member) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
  }

  function checkEndpoint (endpoint) {
    if (!validEndpoint(endpoint)) throw new TypeError('endpoint must be an https URL of at most ' + ENDPOINT_MAX + ' characters')
  }

  function put ({ member, endpoint, p256dh, auth } = {}) {
    return enqueue(() => {
      checkMember(member)
      checkEndpoint(endpoint)
      if (!validP256dh(p256dh)) throw new TypeError('invalid p256dh')
      if (!validAuth(auth)) throw new TypeError('invalid auth')
      const { next, evicted, stale } = reread()
      const found = findEndpoint(next, endpoint)
      const own = found !== null && found.member === member
      if (own) {
        const row = next.members[member][found.i]
        if (row.p256dh === p256dh && row.auth === auth) {
          settle(next, evicted, stale)
          return { changed: false }
        }
      }
      // An endpoint moves to another member only with the keys of the same
      // browser subscription (a new identity after Recomeçar): knowing the
      // endpoint URL alone must not take someone else's notices.
      if (found !== null && !own) {
        const row = next.members[found.member][found.i]
        if (row.p256dh !== p256dh || row.auth !== auth) {
          settle(next, evicted, stale)
          throw fail('pedido-invalido')
        }
      }
      // Counted as after the move: a transfer that does not add a member is
      // never refused.
      const leaving = found !== null && !own && next.members[found.member].length === 1 ? 1 : 0
      if (!next.members[member] && Object.keys(next.members).length - leaving >= MAX_MEMBERS) {
        settle(next, evicted, stale)
        throw fail('limite')
      }
      const buried = evicted.slice()
      const createdAt = freshDate(next, buried, member, endpoint)
      if (found) {
        const list = next.members[found.member]
        const [old] = list.splice(found.i, 1)
        if (list.length === 0) delete next.members[found.member]
        if (!own) buried.push([found.member, endpoint, old.createdAt])
      }
      const list = next.members[member] || []
      list.push({ endpoint, p256dh, auth, createdAt })
      buried.push(...cap(member, list))
      next.members[member] = list
      persist(next, buried)
      return { changed: true }
    })
  }

  function remove ({ member, endpoint } = {}) {
    return enqueue(() => {
      checkMember(member)
      checkEndpoint(endpoint)
      const { next, evicted, stale } = reread()
      const list = next.members[member] || []
      const i = list.findIndex((r) => r.endpoint === endpoint)
      if (i === -1) {
        settle(next, evicted, stale)
        return { changed: false }
      }
      const [old] = list.splice(i, 1)
      if (list.length === 0) delete next.members[member]
      persist(next, [...evicted, [member, endpoint, old.createdAt]])
      return { changed: true }
    })
  }

  function removeAll (member) {
    return enqueue(() => {
      checkMember(member)
      const { next, evicted, stale } = reread()
      const list = next.members[member]
      if (!list) {
        settle(next, evicted, stale)
        return { changed: false }
      }
      delete next.members[member]
      persist(next, [...evicted, ...list.map((r) => [member, r.endpoint, r.createdAt])])
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
    return (state.members[member] || []).map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }))
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
    put,
    remove,
    removeAll,
    heal,
    list,
    devices,
    count,
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openPushStore,
  FILE,
  PUSH_MAX_PER_MEMBER,
  MAX_MEMBERS,
  ENDPOINT_MAX,
  TOMBSTONE_MAX,
  // Exposed for the route, which validates before proving.
  validEndpoint,
  validP256dh,
  validAuth
}
