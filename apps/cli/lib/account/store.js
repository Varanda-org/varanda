'use strict'

// The account service's directory: which Google subject is linked to which
// member diary, under which @username, with the v2 certificate and the
// username records the issuer signed. ONE file, <dataDir>/directory.json
// (mode 0o600, data dir 0o700), always replaced whole through writeJsonAtomic
// (packages/core/lib/store.js: O_EXCL temp, fsync, rename, dir fsync), so a
// crash before the rename leaves the previous file and a crash after it
// leaves the new one; the in-memory copy is swapped only after the write
// returned. A write that throws may still have landed (the directory fsync
// after the rename failed), so the in-memory copy is then reloaded from disk
// before the error propagates: memory never disagrees with the file, and a
// later mutation never overwrites a link or rename that was published.
//
// Invariants: one sub <-> one member; a member holds one current @username;
// a name ever held by a member (`usedNames`) is never given to ANOTHER member
// (the same member may take it back), so an old record copied around can
// never be mistaken for someone else.
//
// Pending link rows (Google transaction secrets: state, PKCE verifier) live in
// memory only and are never written to disk: at most MAX_PENDING live rows,
// at most MAX_UNPROVEN_PER_MEMBER unproven ones per member and at most
// MAX_PER_SUB rows per Google subject (see start(), unproven() and
// putGoogle()). Error objects carry only a
// token in `code` (and `nextChangeAt` for 'troca-bloqueada'): no sub, e-mail
// or secret.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const {
  isHex,
  isUsername,
  refuseSymlinkDir,
  createIssuedCert,
  createUsernameRecord
} = require('@varanda/core/lib/cert')

const FILE = 'directory.json'
const VERSION = 1
const PENDING_TTL_MS = 600 * 1000
const MAX_PENDING = 1000
const MAX_UNPROVEN_PER_MEMBER = 3
const MAX_PER_SUB = 2
const COOLDOWN_MS = 7 * 24 * 3600 * 1000
// Names a member could use to pass for the association or its staff.
const RESERVED = new Set([
  'admin', 'associacao', 'association', 'ajuda', 'mod', 'moderacao',
  'root', 'seeder', 'semeador', 'suporte', 'support', 'varanda'
])

function fail (code, extra) {
  const err = new Error(code)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

function randomToken () {
  return crypto.randomBytes(32).toString('base64url')
}

function validName (username) {
  return isUsername(username) && !RESERVED.has(username)
}

function normalizeMember (member) {
  if (!isHex(member, 32)) throw new TypeError('member must be 64 hex characters')
  return member.toLowerCase()
}

// Null-prototype maps: a Google `sub` is arbitrary printable ASCII and could
// be '__proto__', which must stay an ordinary key.
function dict (src) {
  const out = Object.create(null)
  if (src !== null && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) out[k] = v
  }
  return out
}

function emptyState () {
  return { v: VERSION, links: dict(), bySub: dict(), byUsername: dict(), usedNames: dict() }
}

function fromJson (obj) {
  if (obj === null || typeof obj !== 'object' || obj.v !== VERSION) {
    throw new Error('diretório de contas inválido')
  }
  const links = dict()
  for (const [member, link] of Object.entries(obj.links || {})) links[member] = { ...link }
  return {
    v: VERSION,
    links,
    bySub: dict(obj.bySub),
    byUsername: dict(obj.byUsername),
    usedNames: dict(obj.usedNames)
  }
}

// Deep enough copy for a mutation: links are replaced, never edited in place.
function cloneState (s) {
  const links = dict()
  for (const member in s.links) links[member] = s.links[member]
  return {
    v: VERSION,
    links,
    bySub: dict(s.bySub),
    byUsername: dict(s.byUsername),
    usedNames: dict(s.usedNames)
  }
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function readDirectory (file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState()
    throw err
  }
  if (!st.isFile()) throw new Error('diretório de contas inválido')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

// readOnly: for `account status` / `account export` — no mkdir/chmod (works
// on a read-only volume and never changes permissions) and every disk
// mutation answers 'indisponivel'.
function openAccountStore (dataDir, { now = Date.now, readOnly = false } = {}) {
  refuseSymlinkDir(dataDir)
  if (!readOnly) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dataDir, 0o700)
  }
  const file = path.join(dataDir, FILE)
  let state = readDirectory(file)
  const pending = new Map()
  let failed = readOnly
  let tail = Promise.resolve()

  // One in-process queue for every disk mutation, so two finishes (or a
  // finish and a rename) never read the same state and both write.
  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function iso (ms) {
    return new Date(ms).toISOString()
  }

  function nextChangeAt (link) {
    return iso(Date.parse(link.usernameChangedAt) + COOLDOWN_MS)
  }

  function sweep () {
    const t = now()
    for (const [id, row] of pending) {
      if (row.expiresAt <= t) pending.delete(id)
    }
  }

  function liveRow (id) {
    if (typeof id !== 'string') return null
    const row = pending.get(id)
    if (row === undefined) return null
    if (row.expiresAt <= now()) {
      pending.delete(id)
      return null
    }
    return row
  }

  // True when `username` is taken for `member`: currently held or ever used
  // by another member, or held by another member's live Google-claimed row.
  // A row holds its name only once Google answered (it has `sub`): a key
  // proof alone costs nothing (keys are free), so a key-proven row holds
  // nothing and finish() re-checks the name anyway. Two claimed rows may
  // name the same username (both started before either reached Google):
  // the FIRST to claim holds it (putGoogle moves the row to the end of the
  // table, so claimed rows sit in claim order), the other's finish answers
  // 'nome-em-uso', and neither blocks the other.
  function nameTaken (s, username, member) {
    if (has(s.byUsername, username) && s.byUsername[username] !== member) return true
    if (has(s.usedNames, username) && s.usedNames[username] !== member) return true
    sweep()
    for (const row of pending.values()) {
      if (unproven(row) || row.username !== username) continue
      return row.member !== member
    }
    return false
  }

  function persist (next) {
    try {
      writeJsonAtomic(file, next, 0o600)
    } catch (err) {
      resync()
      throw err
    }
    state = next
  }

  // After a failed write the file holds either the previous state (the
  // rename never happened) or `next` (the directory fsync after it failed):
  // reload it with the open-time validation. An unreadable or malformed file
  // keeps the old copy and marks the store unavailable, so no later mutation
  // writes over a file whose contents are unknown.
  function resync () {
    try {
      state = readDirectory(file)
    } catch {
      failed = true
    }
  }

  function mutable () {
    if (failed) throw fail('indisponivel')
  }

  // A row is unproven until putGoogle() (Google answered: it has `sub`). A
  // member signature (reserve()) does not count: member keys are free to
  // generate, so a key-proven row is as cheap for an attacker as a bare
  // start, while a Google answer costs an account that putGoogle() caps at
  // MAX_PER_SUB rows. Only unproven rows are ever evicted for room (oldest
  // first): a Google-claimed row lives out its TTL, and a table full of
  // claimed rows refuses with 'lotado'.
  function unproven (row) {
    return !Object.hasOwn(row, 'sub')
  }

  // A bare row only went through start(): no key proof yet. Member keys are
  // public, so the per-member cap (which anyone can trigger by naming a key)
  // only ever evicts bare rows: a row the member signed (reserve) survives
  // until Google answers or its TTL ends, unless a flood fills the table.
  function bare (row) {
    return row.phase === 'reserve' && unproven(row)
  }

  // Drops the oldest pending row for which `match(row)` is true.
  function evictOldest (match) {
    for (const [id, row] of pending) {
      if (match(row)) {
        pending.delete(id)
        return true
      }
    }
    return false
  }

  function start ({ member, username } = {}) {
    member = normalizeMember(member)
    if (!validName(username)) throw fail('nome-invalido')
    if (has(state.links, member)) throw fail('conta-vinculada')
    if (nameTaken(state, username, member)) throw fail('nome-em-uso')
    sweep()
    let own = 0
    for (const row of pending.values()) {
      if (row.member === member && bare(row)) own++
    }
    if (own >= MAX_UNPROVEN_PER_MEMBER) evictOldest((row) => row.member === member && bare(row))
    // Table full (only a flood gets here): the oldest row without a Google
    // answer goes, bare or signed, so new logins outlive abandoned ones;
    // claimed rows are never evicted.
    if (pending.size >= MAX_PENDING && !evictOldest(unproven)) throw fail('lotado')
    const row = {
      id: randomToken(),
      member,
      username,
      nonce: randomToken(),
      state: randomToken(),
      verifier: randomToken(),
      phase: 'reserve',
      expiresAt: now() + PENDING_TTL_MS
    }
    pending.set(row.id, row)
    return { ...row }
  }

  // The member proved its key: the next signature it gives is the 'finish'
  // one. The name is checked again here but not held yet (see nameTaken).
  function reserve (id) {
    const row = liveRow(id)
    if (row === null) throw fail('expirado')
    if (nameTaken(state, row.username, row.member)) throw fail('nome-em-uso')
    row.reserved = true
    row.phase = 'finish'
    return { ...row }
  }

  // Google answered: from here the row holds its name (if no earlier claim
  // does) and is never evicted for room. One Google account may claim at
  // most MAX_PER_SUB live rows (a double click, two tabs); a further claim
  // replaces its oldest row. The row moves to the end of the table so that
  // claimed rows are ordered by claim (see nameTaken).
  function putGoogle (id, { sub, email } = {}) {
    const row = liveRow(id)
    if (row === null) throw fail('expirado')
    sweep()
    const same = []
    for (const [otherId, other] of pending) {
      if (otherId !== id && other.sub === sub) same.push(otherId)
    }
    while (same.length >= MAX_PER_SUB) pending.delete(same.shift())
    pending.delete(id)
    row.sub = sub
    row.email = email
    pending.set(id, row)
    return { ...row }
  }

  function get (id) {
    const row = liveRow(id)
    return row === null ? null : { ...row }
  }

  function linkResult (link) {
    return { cert: link.cert, usernameRecord: link.usernameRecord, nextChangeAt: nextChangeAt(link) }
  }

  // -> { cert, usernameRecord, nextChangeAt }, resolved only after the
  // directory is on disk. The row is deleted after success, so a repeated
  // finish answers 'expirado' (the client recovers through status()).
  function finish (id, { signature } = {}, issuerKeyPair, issuerCert, association) {
    return enqueue(() => {
      mutable()
      const row = liveRow(id)
      if (row === null || typeof row.sub !== 'string') throw fail('expirado')
      if (issuerCert === null || typeof issuerCert !== 'object' || issuerCert.association !== association) {
        throw new TypeError('issuer certificate is for another association')
      }
      const { member, username, sub, email } = row

      if (has(state.bySub, sub) && state.bySub[sub] === member) {
        const link = state.links[member]
        if (link.email !== email) {
          const next = cloneState(state)
          next.links[member] = { ...link, email }
          persist(next)
        }
        pending.delete(id)
        return linkResult(state.links[member])
      }
      if (has(state.bySub, sub) || has(state.links, member)) throw fail('conta-vinculada')
      if (!validName(username)) throw fail('nome-invalido')
      if (nameTaken(state, username, member)) throw fail('nome-em-uso')

      const date = iso(now())
      const cert = createIssuedCert({ member, date }, issuerKeyPair, issuerCert)
      const usernameRecord = createUsernameRecord({ member, username, date }, issuerKeyPair, issuerCert)
      const next = cloneState(state)
      next.links[member] = {
        sub,
        email,
        username,
        usernameRecord,
        usernameChangedAt: date,
        linkedAt: date,
        nonce: row.nonce,
        signature,
        cert
      }
      next.bySub[sub] = member
      next.byUsername[username] = member
      next.usedNames[username] = member
      persist(next)
      pending.delete(id)
      return linkResult(next.links[member])
    })
  }

  // -> { record, nextChangeAt }. Same name: the current record, unchanged.
  function rename (member, username, issuerKeyPair, issuerCert) {
    return enqueue(() => {
      mutable()
      member = normalizeMember(member)
      if (!has(state.links, member)) throw fail('nao-encontrado')
      if (!validName(username)) throw fail('nome-invalido')
      const link = state.links[member]
      if (link.username === username) return { record: link.usernameRecord, nextChangeAt: nextChangeAt(link) }
      const t = now()
      if (t < Date.parse(link.usernameChangedAt) + COOLDOWN_MS) {
        throw fail('troca-bloqueada', { nextChangeAt: nextChangeAt(link) })
      }
      if (nameTaken(state, username, member)) throw fail('nome-em-uso')

      const date = iso(t)
      const record = createUsernameRecord({ member, username, date }, issuerKeyPair, issuerCert)
      const next = cloneState(state)
      // The old name leaves byUsername but stays in usedNames for this member.
      if (next.byUsername[link.username] === member) delete next.byUsername[link.username]
      next.byUsername[username] = member
      next.usedNames[username] = member
      next.links[member] = { ...link, username, usernameRecord: record, usernameChangedAt: date }
      persist(next)
      return { record, nextChangeAt: nextChangeAt(next.links[member]) }
    })
  }

  function status (member) {
    if (!isHex(member, 32)) return { linked: false }
    const link = state.links[member.toLowerCase()]
    if (link === undefined) return { linked: false }
    return {
      linked: true,
      username: link.username,
      cert: link.cert,
      usernameRecord: link.usernameRecord,
      nextChangeAt: nextChangeAt(link)
    }
  }

  // Current holder only: a released name answers null.
  function lookup (username) {
    if (typeof username !== 'string' || !has(state.byUsername, username)) return null
    const member = state.byUsername[username]
    return { member, usernameRecord: state.links[member].usernameRecord }
  }

  // For the operator (LGPD access requests): no signature, cert or secret.
  function exportLinks () {
    return Object.keys(state.links).map((member) => {
      const { sub, email, username, linkedAt } = state.links[member]
      return { member, sub, email, username, linkedAt }
    })
  }

  return { start, reserve, putGoogle, get, finish, rename, status, lookup, exportLinks }
}

module.exports = {
  FILE,
  COOLDOWN_MS,
  PENDING_TTL_MS,
  MAX_PENDING,
  MAX_UNPROVEN_PER_MEMBER,
  MAX_PER_SUB,
  RESERVED,
  openAccountStore
}
