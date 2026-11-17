'use strict'

// The passkeys the account service holds for Excluir conta (docs/protocol.md
// "Account deletion"): for each member key, the public keys of its passkeys
// (read from the creation's attestation object, ./webauthn.js) with their
// signature counters, and the deletion the member asked for without a
// verified passkey, waiting for its date (`hold`). ONE sidecar file,
// <dataDir>/passkeys.json (mode 0o600), always replaced whole through
// writeJsonAtomic, never part of directory.json or its journal, for the same
// reason as ./recovery-store.js: older and newer builds keep opening the
// same data dir. Never an e-mail, a sub or a username, and nothing from
// this file is logged.
//
// The file discipline is ./recovery-store.js's: opening never creates
// anything, a readOnly store never writes, validation is total (a file this
// module would not have written makes every method throw
// { code: 'indisponivel' } until an operator repairs it), every write runs in
// one queue, re-reads the file first and asks guard() before the re-read,
// right before the rename (./guarded-write.js; a false answer there leaves
// file and memory as they were) and after the rename, and memory changes
// only once the write landed. Reads after an uncertain write adopt the merge
// of file and memory first, or throw.
//
// A cancelled hold must never come back from a stale copy (that would delete
// an account its owner kept), so a plain union is not enough. Each member's
// record and each tombstone carries a generation drawn from ONE store-level
// counter `seq` (merged as max(memory, disk)); every change to a member takes
// gen = ++seq for the whole record, and a merge keeps, per member, the record
// or tombstone with the higher gen (ties keep memory). forget() (the account
// was deleted) leaves a tombstone, pruned after TOMBSTONE_TTL_MS; a copy
// older than a pruned tombstone may bring keys back for a deleted key, which
// is harmless (the directory never links that key again) and the deletion
// sweep forgets them again.
//
// Each key carries `lookupId`: null for the passkey enrolled at sign-up, the
// lookupId of its recovery entry (./recovery-store.js) for an extra passkey
// whose key an already stored passkey vouched for (./passkey-routes.js), so
// removing that entry drops its key too (./recovery-routes.js), and
// `entryAt`: null for the sign-up passkey, that entry's createdAt for an
// extra one, so the key belongs to that entry and not to a later entry put
// at the same lookupId (countedKeys). Version 1 files (no lookupId) still
// open, their keys read as lookupId and entryAt null; a write is version 2
// only while some key has a lookupId.

const fs = require('node:fs')
const path = require('node:path')
const { writeGuarded, isRefused } = require('./guarded-write')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { fromB64url, MAX_CREDENTIAL_ID, ES256, RS256 } = require('./webauthn')
const { MAX_PASSKEYS } = require('./recovery-store')

const FILE = 'passkeys.json'
const VERSION = 2
// The sign-up passkey plus one per extra passkey recovery entry.
const MAX_KEYS = 1 + MAX_PASSKEYS
const MAX_SPKI_HEX = 1200
const MAX_COUNTER = 0xffffffff
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000
const FILE_KEYS = ['v', 'seq', 'members', 'removed']
const RECORD_KEYS = ['keys', 'hold', 'gen']
const KEY_KEYS_V1 = ['credentialId', 'alg', 'spki', 'signCount', 'addedAt']
const KEY_KEYS = [...KEY_KEYS_V1, 'lookupId', 'entryAt']
const HOLD_KEYS = ['at', 'runAt']
const TOMB_KEYS = ['removedAt', 'gen']

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

function validGen (g) {
  return Number.isSafeInteger(g) && g >= 1
}

function validCredentialId (id) {
  return typeof id === 'string' && fromB64url(id, MAX_CREDENTIAL_ID) !== null && !id.includes('=')
}

function validSpki (s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_SPKI_HEX && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s)
}

function validCounter (n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_COUNTER
}

function validLink (k) {
  return k.lookupId === null ? k.entryAt === null : isLowerHex(k.lookupId, 32) && isCanonicalIso(k.entryAt)
}

function validKey (k, v) {
  return isPlainObject(k) &&
    (v === 1 ? exactKeys(k, KEY_KEYS_V1) : exactKeys(k, KEY_KEYS) && validLink(k)) &&
    validCredentialId(k.credentialId) &&
    (k.alg === ES256 || k.alg === RS256) &&
    validSpki(k.spki) &&
    validCounter(k.signCount) &&
    isCanonicalIso(k.addedAt)
}

function validHold (h) {
  return h === null || (isPlainObject(h) && exactKeys(h, HOLD_KEYS) && isCanonicalIso(h.at) && isCanonicalIso(h.runAt))
}

function validRecord (r, v) {
  if (!isPlainObject(r) || !exactKeys(r, RECORD_KEYS) || !Array.isArray(r.keys) || r.keys.length > MAX_KEYS) return false
  if (!r.keys.every((k) => validKey(k, v)) || new Set(r.keys.map((k) => k.credentialId)).size !== r.keys.length) return false
  const linked = r.keys.map((k) => k.lookupId).filter((id) => typeof id === 'string')
  if (new Set(linked).size !== linked.length) return false
  return validHold(r.hold) && validGen(r.gen)
}

function validTomb (t) {
  return isPlainObject(t) && exactKeys(t, TOMB_KEYS) && isCanonicalIso(t.removedAt) && validGen(t.gen)
}

function copyKey (k) {
  return { credentialId: k.credentialId, alg: k.alg, spki: k.spki, signCount: k.signCount, addedAt: k.addedAt, lookupId: k.lookupId === undefined ? null : k.lookupId, entryAt: k.entryAt === undefined ? null : k.entryAt }
}

function copyRecord (r) {
  return { keys: r.keys.map(copyKey), hold: r.hold === null ? null : { at: r.hold.at, runAt: r.hold.runAt }, gen: r.gen }
}

function copyTomb (t) {
  return { removedAt: t.removedAt, gen: t.gen }
}

function invalidFile () {
  return Object.assign(new Error('passkeys inválido'), { invalid: true })
}

function emptyState () {
  return { v: VERSION, seq: 0, members: Object.create(null), removed: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, FILE_KEYS) || (obj.v !== 1 && obj.v !== VERSION)) throw invalidFile()
  if (!Number.isSafeInteger(obj.seq) || obj.seq < 0) throw invalidFile()
  if (!isPlainObject(obj.members) || !isPlainObject(obj.removed)) throw invalidFile()
  const state = emptyState()
  state.seq = obj.seq
  for (const [m, r] of Object.entries(obj.members)) {
    if (!validMember(m) || !validRecord(r, obj.v) || r.gen > obj.seq) throw invalidFile()
    state.members[m] = copyRecord(r)
  }
  for (const [m, t] of Object.entries(obj.removed)) {
    if (!validMember(m) || !validTomb(t) || t.gen > obj.seq || has(state.members, m)) throw invalidFile()
    state.removed[m] = copyTomb(t)
  }
  return state
}

function readState (file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!st.isFile()) throw invalidFile()
  let obj
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err instanceof SyntaxError) throw invalidFile()
    throw err
  }
  return fromJson(obj)
}

function fingerprint (file) {
  try {
    const st = fs.lstatSync(file)
    return [st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Version 1 while no key is linked to a recovery entry, so a file holding
// only sign-up keys stays readable by the previous build; version 2 once an
// extra passkey's key is stored.
function toJson (state) {
  const members = {}
  for (const m of Object.keys(state.members).sort()) members[m] = copyRecord(state.members[m])
  const removed = {}
  for (const m of Object.keys(state.removed).sort()) removed[m] = copyTomb(state.removed[m])
  const linked = Object.values(members).some((r) => r.keys.some((k) => k.lookupId !== null))
  if (!linked) {
    for (const r of Object.values(members)) r.keys = r.keys.map(({ lookupId, entryAt, ...k }) => k)
  }
  return { v: linked ? VERSION : 1, seq: state.seq, members, removed }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

function genOf (state, m) {
  if (!state) return 0
  if (has(state.members, m)) return state.members[m].gen
  if (has(state.removed, m)) return state.removed[m].gen
  return 0
}

function nextGen (state) {
  state.seq += 1
  return state.seq
}

function normalize (state, nowMs) {
  const cutoff = nowMs - TOMBSTONE_TTL_MS
  for (const [m, t] of Object.entries(state.removed)) {
    if (Date.parse(t.removedAt) < cutoff) delete state.removed[m]
  }
  return state
}

function merge (mem, disk, nowMs) {
  const out = emptyState()
  out.seq = Math.max(mem.seq, disk ? disk.seq : 0)
  const ids = new Set([...Object.keys(mem.members), ...Object.keys(mem.removed)])
  if (disk) for (const m of [...Object.keys(disk.members), ...Object.keys(disk.removed)]) ids.add(m)
  for (const m of ids) {
    const src = disk && genOf(disk, m) > genOf(mem, m) ? disk : mem
    if (has(src.members, m)) out.members[m] = copyRecord(src.members[m])
    else out.removed[m] = copyTomb(src.removed[m])
  }
  return normalize(out, nowMs)
}

function checkMember (member) {
  if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
}

function openPasskeyStore (dataDir, { now = Date.now, readOnly = false, guard = () => true, log = () => {} } = {}) {
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, FILE)
  let state = emptyState()
  let failed = false
  let dirty = false
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

  function persist (next) {
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
  }

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

  function settle (next, stale) {
    if (stale) persist(next)
    else state = next
  }

  // The member's record in `next`, created empty when there is none (a
  // tombstone is replaced: the new record takes a higher gen).
  function recordIn (next, member) {
    if (has(next.members, member)) return next.members[member]
    return { keys: [], hold: null, gen: 0 }
  }

  function commit (next, member, record) {
    delete next.removed[member]
    record.gen = nextGen(next)
    next.members[member] = record
    persist(normalize(next, now()))
  }

  // Records a passkey's public key. `first` (enrolment at link time,
  // ./passkey-routes.js) refuses with 'passkey-registrada' when the member
  // already has another key. An extra passkey (first false) names its
  // recovery entry's lookupId and createdAt (`entryAt`) and, as `voucher`,
  // the credential id of the stored key whose assertion vouched for it: that
  // key must still be here when the write runs ('passkey-invalida'), so a
  // deletion that forgot the record meanwhile is not undone by a lone extra
  // key. A key already linked
  // to that entry refuses with 'pedido-invalido', and MAX_KEYS with
  // 'limite-recuperacao'. The same credential again is a no-op.
  // -> { changed }
  function add ({ member, credentialId, alg, spki, signCount, first = true, lookupId = null, entryAt = null, voucher = null } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!validCredentialId(credentialId) || (alg !== ES256 && alg !== RS256) || !validSpki(spki) || !validCounter(signCount)) throw new TypeError('invalid passkey')
      if (first ? lookupId !== null || entryAt !== null || voucher !== null : !isLowerHex(lookupId, 32) || !isCanonicalIso(entryAt) || !validCredentialId(voucher)) throw new TypeError('invalid lookupId')
      const { next, stale } = reread()
      const record = copyRecord(recordIn(next, member))
      const same = record.keys.find((k) => k.credentialId === credentialId)
      if (same !== undefined) {
        settle(next, stale)
        if (same.alg !== alg || same.spki !== spki) throw fail('passkey-registrada')
        return { changed: false }
      }
      if (first && record.keys.length > 0) {
        settle(next, stale)
        throw fail('passkey-registrada')
      }
      if (!first && !record.keys.some((k) => k.credentialId === voucher)) {
        settle(next, stale)
        throw fail('passkey-invalida')
      }
      if (lookupId !== null && record.keys.some((k) => k.lookupId === lookupId)) {
        settle(next, stale)
        throw fail('pedido-invalido')
      }
      if (record.keys.length >= MAX_KEYS) {
        settle(next, stale)
        throw fail('limite-recuperacao')
      }
      record.keys.push({ credentialId, alg, spki, signCount, addedAt: new Date(now()).toISOString(), lookupId, entryAt })
      commit(next, member, record)
      return { changed: true }
    })
  }

  // The recovery entry lookupId was removed: the key linked to it goes too,
  // so that passkey no longer confirms a deletion at once. -> { changed }
  function removeByLookup ({ member, lookupId } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!isLowerHex(lookupId, 32)) throw new TypeError('invalid lookupId')
      const { next, stale } = reread()
      const record = copyRecord(recordIn(next, member))
      const kept = record.keys.filter((k) => k.lookupId !== lookupId)
      if (kept.length === record.keys.length) {
        settle(next, stale)
        return { changed: false }
      }
      record.keys = kept
      commit(next, member, record)
      return { changed: true }
    })
  }

  // A verified assertion moved the counter: keeps the higher one.
  // -> { changed }
  function touch ({ member, credentialId, signCount } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!validCounter(signCount)) throw new TypeError('invalid counter')
      const { next, stale } = reread()
      const record = copyRecord(recordIn(next, member))
      const key = record.keys.find((k) => k.credentialId === credentialId)
      if (key === undefined || signCount <= key.signCount) {
        settle(next, stale)
        return { changed: false }
      }
      key.signCount = signCount
      commit(next, member, record)
      return { changed: true }
    })
  }

  // A deletion waiting for runAt (ISO). An existing hold is kept as it is:
  // asking again never moves its date. -> { changed, at, runAt }
  function schedule ({ member, runAt } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!isCanonicalIso(runAt)) throw new TypeError('runAt must be a canonical ISO date')
      const { next, stale } = reread()
      const record = copyRecord(recordIn(next, member))
      if (record.hold !== null) {
        settle(next, stale)
        return { changed: false, at: record.hold.at, runAt: record.hold.runAt }
      }
      record.hold = { at: new Date(now()).toISOString(), runAt }
      commit(next, member, record)
      return { changed: true, at: record.hold.at, runAt }
    })
  }

  // -> { changed }
  function cancel (member) {
    return enqueue(() => {
      checkMember(member)
      const { next, stale } = reread()
      const record = copyRecord(recordIn(next, member))
      if (record.hold === null) {
        settle(next, stale)
        return { changed: false }
      }
      record.hold = null
      commit(next, member, record)
      return { changed: true }
    })
  }

  // Excluir conta: the member's record goes, leaving a tombstone.
  // -> { changed }
  function forget (member) {
    return enqueue(() => {
      checkMember(member)
      const { next, stale } = reread()
      if (!has(next.members, member)) {
        settle(next, stale)
        return { changed: false }
      }
      const nowMs = now()
      delete next.members[member]
      next.removed[member] = { removedAt: new Date(nowMs).toISOString(), gen: nextGen(next) }
      persist(normalize(next, nowMs))
      return { changed: true }
    })
  }

  function heal () {
    return enqueue(() => {
      if (failed || readOnly || !guard()) return false
      let seen, disk
      try {
        seen = fingerprint(file)
        if (!dirty && seen === healed) return false
        disk = readState(file)
      } catch (err) {
        if (err.invalid === true) failed = true
        else log({ event: 'passkeys', reason: 'leitura-falhou', code: typeof err.code === 'string' ? err.code : 'desconhecido' })
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

  // -> [{ credentialId, alg, spki, signCount, addedAt, lookupId, entryAt }], oldest
  // first.
  function keys (member) {
    checkMember(member)
    fresh()
    return has(state.members, member) ? state.members[member].keys.map(copyKey) : []
  }

  // -> { at, runAt } or null.
  function hold (member) {
    checkMember(member)
    fresh()
    const r = has(state.members, member) ? state.members[member] : null
    return r === null || r.hold === null ? null : { at: r.hold.at, runAt: r.hold.runAt }
  }

  // The members whose hold reached its date, oldest date first.
  function due (nowMs = now()) {
    fresh()
    const out = []
    for (const [m, r] of Object.entries(state.members)) {
      if (r.hold !== null && Date.parse(r.hold.runAt) <= nowMs) out.push({ member: m, runAt: r.hold.runAt })
    }
    return out.sort((a, b) => (a.runAt < b.runAt ? -1 : a.runAt > b.runAt ? 1 : a.member < b.member ? -1 : 1)).map((e) => e.member)
  }

  // True while anything of member is kept (the deletion sweep asks).
  function holds (member) {
    checkMember(member)
    fresh()
    return has(state.members, member)
  }

  return {
    add,
    removeByLookup,
    touch,
    schedule,
    cancel,
    forget,
    heal,
    keys,
    hold,
    due,
    holds,
    fail () { failed = true },
    available () { return !failed }
  }
}

// The keys of `keys` (a member's, from keys()) that count to confirm a
// deletion or vouch for a new passkey: the sign-up key always, an extra key
// only while the entry it was stored with is live: a 'passkey' entry of the
// same member in `recovery` (an openRecoveryStore) with its lookupId and,
// as createdAt, its entryAt. Without a recovery store that answers, no extra
// key counts. So a key whose entry is gone (removed while this file could
// not be written, or by a remove racing the add) is inert, also after an
// entry is put again at the same lookupId.
function countedKeys (keys, recovery, member) {
  if (!keys.some((k) => k.lookupId !== null)) return keys
  let rows = null
  try {
    if (recovery !== null && recovery.available()) rows = recovery.list(member)
  } catch {}
  return keys.filter((k) => k.lookupId === null || (rows !== null && entryOf(k, rows)))
}

// Whether `rows` (recovery list(member)) holds the entry an extra key was
// stored with.
function entryOf (k, rows) {
  return rows.some((r) => r.kind === 'passkey' && r.lookupId === k.lookupId && r.createdAt === k.entryAt)
}

module.exports = {
  countedKeys,
  entryOf,
  openPasskeyStore,
  FILE,
  MAX_KEYS,
  TOMBSTONE_TTL_MS
}
