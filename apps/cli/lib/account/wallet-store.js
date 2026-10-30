'use strict'

// The optional payments account (Hodle) of each member: ONE sidecar file,
// <dataDir>/wallet.json (mode 0o600), always replaced whole through
// writeJsonAtomic (packages/core/lib/store.js), kept apart from
// account/store.js for the same reason as terms.json and age.json.
//
// It holds identifiers plus the wallet's wrapped key: the subaccount id, the
// network, the KYC state of the current attempt with Hodle's attempt and
// upload ids, the wallet id and address, and the protectedSymmetricKey Hodle
// returned. That key is useless without the member's PIN, and it is never
// returned to the browser. The PIN itself is never here: Hodle unwraps the
// key with it, so whoever holds both can move the member's money, and the
// PIN is typed for each operation and relayed for that request only. Nor is
// anything Hodle collects for KYC (CPF, legal name, birth date, e-mail,
// postal address, images), upload or liveness URLs, provider bodies or
// balances. Every entry has exactly the keys below and a file with any other
// key is unavailable, so none of that can creep in.
//
// Creation intent is written before the call that creates: the
// subaccountUncertain and walletUncertain markers go to disk BEFORE
// createSubaccount and createWallet, because a call whose answer was lost
// may still have created something and every create at Hodle mints a new
// one. A member with a marker is frozen until a readable answer adopts what
// exists or the operator clears it; the store never decides to create again.
//
// Opening never creates, mkdirs or chmods anything (a missing file means no
// member opened an account yet) and a readOnly store never writes.
// Validation is total: a file this module would not have written is never
// rewritten, and every method then throws { code: 'indisponivel' } until an
// operator repairs it. Bad argument shapes throw TypeError.
//
// Every write runs in one in-process queue and first re-reads the file (the
// service lock can go stale and writeJsonAtomic renames unconditionally), so
// memory and disk are merged per member before the change is applied: a
// known subaccount beats an intent, then the earlier createdAt wins, and the
// winner is kept whole when the two copies name different subaccounts. For
// one subaccount: KYC by higher attempt, then rank (nenhum < documentos <
// pendente < recusado = expirado < aprovado), then later updatedAt; the
// first wallet wins forever; each marker keeps its newer change (set or
// clear, stamped in *MarkAt) and drops once what it guards exists.
//
// As in age-store, memory holds only what was durably written: a write that
// throws, or whose guard() refuses after the write, leaves memory as it was
// and marks the store dirty, which forces the next write or heal to rewrite
// the merge.

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'wallet.json'
const VERSION = 1
const NETWORKS = Object.freeze(['polygon', 'base'])
const KYC_STATUSES = Object.freeze(['nenhum', 'documentos', 'pendente', 'aprovado', 'recusado', 'expirado'])
const RANK = Object.freeze({ nenhum: 0, documentos: 1, pendente: 2, recusado: 3, expirado: 3, aprovado: 4 })
const ENTRY_KEYS = [
  'subAccountId', 'subaccountUncertain', 'subaccountMarkAt', 'network', 'kyc',
  'wallet', 'walletUncertain', 'walletMarkAt', 'createdAt'
]
const KYC_KEYS = ['status', 'attempt', 'attemptId', 'documentId', 'selfieId', 'updatedAt']
// Attempt ids this member had before the current one, so a recovery read
// never adopts a closed earlier attempt. Optional on disk: files written
// before it existed have no such key, and it is written only when non-empty.
const PREVIOUS_KEY = 'previousAttemptIds'
const MAX_PREVIOUS = 5
const WALLET_KEYS = ['id', 'address', 'protectedSymmetricKey', 'createdAt']
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const ADDRESS_RE = /^0x[0-9a-f]{40}$/
// The same check as the Hodle client (hodle.js keyBlob), so a key the client
// accepted can always be stored.
const PSK_RE = /^[\x21-\x7e]+$/
const MAX_PSK = 8192
const MAX_ATTEMPT = 1000000
const CONFLICT = Symbol('conflict')

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

function validId (s) {
  return typeof s === 'string' && ID_RE.test(s)
}

function validIdOrNull (s) {
  return s === null || validId(s)
}

function validAddress (s) {
  return typeof s === 'string' && ADDRESS_RE.test(s)
}

function validPsk (s) {
  return typeof s === 'string' && s.length <= MAX_PSK && PSK_RE.test(s)
}

function validAttempt (n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_ATTEMPT
}

function validPrevious (list) {
  return Array.isArray(list) && list.length <= MAX_PREVIOUS && list.every(validId) && new Set(list).size === list.length
}

function validKyc (k) {
  if (!isPlainObject(k)) return false
  const withPrevious = has(k, PREVIOUS_KEY)
  if (withPrevious && !validPrevious(k[PREVIOUS_KEY])) return false
  return exactKeys(k, withPrevious ? [...KYC_KEYS, PREVIOUS_KEY] : KYC_KEYS) &&
    KYC_STATUSES.includes(k.status) &&
    validAttempt(k.attempt) &&
    validIdOrNull(k.attemptId) &&
    validIdOrNull(k.documentId) &&
    validIdOrNull(k.selfieId) &&
    isCanonicalIso(k.updatedAt)
}

function validWallet (w) {
  return isPlainObject(w) &&
    exactKeys(w, WALLET_KEYS) &&
    validId(w.id) &&
    validAddress(w.address) &&
    validPsk(w.protectedSymmetricKey) &&
    isCanonicalIso(w.createdAt)
}

// A set marker always carries the instant it was set.
function validMarkAt (at, value) {
  return at === null ? !value : isCanonicalIso(at)
}

// The markers only make sense while what they guard is missing; the module
// never writes them otherwise, so a file that has them is not one of ours.
function validEntry (e) {
  return isPlainObject(e) &&
    exactKeys(e, ENTRY_KEYS) &&
    validIdOrNull(e.subAccountId) &&
    typeof e.subaccountUncertain === 'boolean' &&
    !(e.subaccountUncertain && e.subAccountId !== null) &&
    validMarkAt(e.subaccountMarkAt, e.subaccountUncertain) &&
    NETWORKS.includes(e.network) &&
    validKyc(e.kyc) &&
    (e.wallet === null || validWallet(e.wallet)) &&
    !(e.wallet !== null && e.subAccountId === null) &&
    typeof e.walletUncertain === 'boolean' &&
    !(e.walletUncertain && e.wallet !== null) &&
    validMarkAt(e.walletMarkAt, e.walletUncertain) &&
    isCanonicalIso(e.createdAt)
}

function previousOf (k) {
  return has(k, PREVIOUS_KEY) ? k[PREVIOUS_KEY] : []
}

// The last MAX_PREVIOUS distinct ids, most recent last.
function boundPrevious (list) {
  const out = []
  for (const id of list) {
    const at = out.indexOf(id)
    if (at !== -1) out.splice(at, 1)
    out.push(id)
  }
  return out.slice(-MAX_PREVIOUS)
}

function copyKyc (k) {
  const out = {
    status: k.status,
    attempt: k.attempt,
    attemptId: k.attemptId,
    documentId: k.documentId,
    selfieId: k.selfieId,
    updatedAt: k.updatedAt
  }
  const previous = previousOf(k)
  if (previous.length > 0) out[PREVIOUS_KEY] = previous.slice()
  return out
}

function withPrevious (k, list) {
  const bounded = boundPrevious(list.filter((id) => id !== k.attemptId))
  if (bounded.length > 0) k[PREVIOUS_KEY] = bounded
  else delete k[PREVIOUS_KEY]
  return k
}

function copyWallet (w) {
  return w === null
    ? null
    : { id: w.id, address: w.address, protectedSymmetricKey: w.protectedSymmetricKey, createdAt: w.createdAt }
}

function copyEntry (e) {
  return {
    subAccountId: e.subAccountId,
    subaccountUncertain: e.subaccountUncertain,
    subaccountMarkAt: e.subaccountMarkAt,
    network: e.network,
    kyc: copyKyc(e.kyc),
    wallet: copyWallet(e.wallet),
    walletUncertain: e.walletUncertain,
    walletMarkAt: e.walletMarkAt,
    createdAt: e.createdAt
  }
}

function emptyState () {
  return { v: VERSION, members: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'members']) || obj.v !== VERSION) throw new Error('carteira inválida')
  if (!isPlainObject(obj.members)) throw new Error('carteira inválida')
  const state = emptyState()
  for (const [member, entry] of Object.entries(obj.members)) {
    if (!validMember(member) || !validEntry(entry)) throw new Error('carteira inválida')
    state.members[member] = copyEntry(entry)
  }
  checkUnique(state)
  return state
}

// One subaccount and one wallet belong to one member. A state where two
// members share either is never written and a file with it is unavailable,
// so bySubAccount has at most one answer.
function checkUnique (state) {
  const subs = new Set()
  const wallets = new Set()
  for (const e of Object.values(state.members)) {
    if (e.subAccountId !== null) {
      if (subs.has(e.subAccountId)) throw new Error('carteira em conflito')
      subs.add(e.subAccountId)
    }
    if (e.wallet !== null) {
      if (wallets.has(e.wallet.id)) throw new Error('carteira em conflito')
      wallets.add(e.wallet.id)
    }
  }
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
  if (!st.isFile()) throw new Error('carteira inválida')
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

// Ties fall back to the serialised form so the merge never depends on which
// side is memory and which is disk.
function tieBreak (a, b) {
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b
}

function pickIdentity (a, b) {
  if ((a.subAccountId === null) !== (b.subAccountId === null)) return a.subAccountId !== null ? a : b
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b
  return tieBreak(a, b)
}

// The submit intent (pendente with no attempt id yet) written before the
// KYC call.
function isKycIntent (k) {
  return k.status === 'pendente' && k.attemptId === null
}

// `d` undoes the intent `p`: documentos with the same two uploads, stamped
// strictly after it. Only revertKycIntent writes that shape: an ordinary
// documentos write after the intent changes an upload id, and a stale copy
// keeps its older stamp, so neither can pass for a revert.
function revertsIntent (d, p) {
  return d.status === 'documentos' && isKycIntent(p) &&
    d.documentId !== null && d.selfieId !== null &&
    d.documentId === p.documentId && d.selfieId === p.selfieId &&
    d.updatedAt > p.updatedAt
}

function pickKyc (a, b) {
  if (a.attempt !== b.attempt) return a.attempt > b.attempt ? a : b
  if (revertsIntent(a, b)) return a
  if (revertsIntent(b, a)) return b
  if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] > RANK[b.status] ? a : b
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  return tieBreak(a, b)
}

// Within one attempt two writers may each have recorded a different upload
// or the attempt id, so the ids are merged one by one; the winning side's id
// is kept when both have one.
// The earlier ids are a union of both copies, the loser's first so the
// winner's most recent ones survive the bound; an older attempt's own id
// joins them.
function mergeKyc (a, b) {
  const won = pickKyc(a, b)
  const lost = won === a ? b : a
  const out = copyKyc(won)
  const previous = [...previousOf(lost), ...previousOf(won)]
  if (a.attempt !== b.attempt) {
    if (lost.attemptId !== null) previous.unshift(lost.attemptId)
    return withPrevious(out, previous)
  }
  for (const f of ['attemptId', 'documentId', 'selfieId']) {
    if (out[f] === null) out[f] = lost[f]
  }
  if (lost.attemptId !== null && lost.attemptId !== out.attemptId) previous.unshift(lost.attemptId)
  return withPrevious(out, previous)
}

function pickWallet (a, b) {
  if (a === null || b === null) return a || b
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b
  return tieBreak(a, b)
}

// The newer change to a marker wins, so a clear (a refusal, the operator)
// is never undone by a stale copy that still has it set. On the same instant
// the set wins, as the safer side.
function pickMarker (aValue, aAt, bValue, bAt) {
  if (aAt !== bAt) {
    if (aAt === null) return { value: bValue, at: bAt }
    if (bAt === null) return { value: aValue, at: aAt }
    return aAt > bAt ? { value: aValue, at: aAt } : { value: bValue, at: bAt }
  }
  return { value: aValue || bValue, at: aAt }
}

// Two copies of one entry. An intent yields whole to a known subaccount: the
// KYC, the wallet and the markers belong to the subaccount they were
// recorded under. Two different known subaccounts for one member only
// happen after a lost lock; picking one would silently drop the other's
// wallet and wrapped key, so the merge refuses and the operator decides.
function mergeEntry (a, b) {
  if (a.subAccountId !== null && b.subAccountId !== null && a.subAccountId !== b.subAccountId) {
    throw new Error('carteira em conflito')
  }
  const id = pickIdentity(a, b)
  if (a.subAccountId !== b.subAccountId) return copyEntry(id)
  const subAccountId = id.subAccountId
  const wallet = subAccountId === null ? null : pickWallet(a.wallet, b.wallet)
  const sub = pickMarker(a.subaccountUncertain, a.subaccountMarkAt, b.subaccountUncertain, b.subaccountMarkAt)
  const wal = pickMarker(a.walletUncertain, a.walletMarkAt, b.walletUncertain, b.walletMarkAt)
  return copyEntry({
    subAccountId,
    subaccountUncertain: subAccountId === null && sub.value,
    subaccountMarkAt: sub.at,
    network: id.network,
    kyc: mergeKyc(a.kyc, b.kyc),
    wallet,
    walletUncertain: wallet === null && wal.value,
    walletMarkAt: wal.at,
    createdAt: id.createdAt
  })
}

function merge (mem, disk) {
  const out = emptyState()
  for (const [member, e] of Object.entries(mem.members)) out.members[member] = copyEntry(e)
  if (disk) {
    for (const [member, e] of Object.entries(disk.members)) {
      const cur = out.members[member]
      out.members[member] = cur ? mergeEntry(cur, e) : copyEntry(e)
    }
  }
  checkUnique(out)
  return out
}

function freshKyc (at) {
  return { status: 'nenhum', attempt: 1, attemptId: null, documentId: null, selfieId: null, updatedAt: at }
}

function ownedByOther (state, member, test) {
  return Object.keys(state.members).some((m) => m !== member && test(state.members[m]))
}

function checkMember (member) {
  if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
}

function checkOptionalId (value, name) {
  if (value !== undefined && !validIdOrNull(value)) throw new TypeError(name + ' must be an id or null')
}

function openWalletStore (dataDir, { now = Date.now, guard = () => true, readOnly = false } = {}) {
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

  function stamp () {
    return new Date(now()).toISOString()
  }

  // Each change to a marker is stamped strictly after the previous one, so
  // the merge can always tell which is newer, even within one millisecond.
  function mark (cur, which, value) {
    const prev = cur[which + 'MarkAt']
    const at = prev === null ? now() : Math.max(now(), Date.parse(prev) + 1)
    cur[which + 'Uncertain'] = value
    cur[which + 'MarkAt'] = new Date(at).toISOString()
  }

  // `state` changes only after the write returned and guard() still holds.
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

  // Runs `change` on a copy of the merged state of memory and disk. `change`
  // returns the entry to store for the member, null for no change, or
  // CONFLICT when the value already belongs to another member; with no
  // change a stale disk is still brought up to date before answering, so
  // memory keeps to durable entries only.
  function mutate (member, change) {
    usable()
    if (readOnly) throw fail('indisponivel')
    if (!guard()) throw fail('indisponivel')
    let disk, base
    try {
      disk = readState(file)
      base = merge(state, disk)
    } catch {
      failed = true
      throw fail('indisponivel')
    }
    const stale = dirty || canonical(base) !== canonical(disk || emptyState())
    const cur = base.members[member] ? copyEntry(base.members[member]) : null
    const entry = change(cur, base)
    if (entry === null || entry === CONFLICT) {
      if (stale) persist(base)
      else state = base
      return entry === CONFLICT ? { changed: false, conflict: true } : { changed: false }
    }
    const next = merge(base, emptyState())
    next.members[member] = copyEntry(entry)
    persist(next)
    return { changed: true }
  }

  // The marker written before createSubaccount. A known subaccount needs no
  // marker; an intent already on file is only re-marked.
  function intendSubaccount ({ member, network } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!NETWORKS.includes(network)) throw new TypeError('network must be one of ' + NETWORKS.join(', '))
      return mutate(member, (cur) => {
        if (cur) {
          if (cur.subAccountId !== null || cur.subaccountUncertain) return null
          mark(cur, 'subaccount', true)
          cur.network = network
          return cur
        }
        const at = stamp()
        return {
          subAccountId: null,
          subaccountUncertain: true,
          subaccountMarkAt: at,
          network,
          kyc: freshKyc(at),
          wallet: null,
          walletUncertain: false,
          walletMarkAt: null,
          createdAt: at
        }
      })
    })
  }

  // Clearing is for an answer that proves nothing was created (a 4xx) or for
  // the operator; setting it again goes through intendSubaccount.
  function clearSubaccountUncertain (member) {
    return enqueue(() => {
      checkMember(member)
      return mutate(member, (cur) => {
        if (!cur || !cur.subaccountUncertain) return null
        mark(cur, 'subaccount', false)
        return cur
      })
    })
  }

  // Subaccounts are permanent at Hodle, so the first one recorded wins and a
  // later create for the same member changes nothing. An id already held by
  // another member is refused with { conflict: true } and never stored.
  function create ({ member, subAccountId, network } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!validId(subAccountId)) throw new TypeError('subAccountId must be an id')
      if (!NETWORKS.includes(network)) throw new TypeError('network must be one of ' + NETWORKS.join(', '))
      return mutate(member, (cur, base) => {
        if (cur && cur.subAccountId !== null) return null
        if (ownedByOther(base, member, (e) => e.subAccountId === subAccountId)) return CONFLICT
        if (cur) {
          cur.subAccountId = subAccountId
          if (cur.subaccountUncertain) mark(cur, 'subaccount', false)
          cur.network = network
          return cur
        }
        const at = stamp()
        return {
          subAccountId,
          subaccountUncertain: false,
          subaccountMarkAt: null,
          network,
          kyc: freshKyc(at),
          wallet: null,
          walletUncertain: false,
          walletMarkAt: null,
          createdAt: at
        }
      })
    })
  }

  // Monotonic within an attempt: a lower rank changes nothing and 'aprovado'
  // is final. 'documentos' after 'recusado' or 'expirado' starts a new
  // attempt with no ids carried over, so answers about the old attempt can
  // no longer touch it. `attempt`, when given, must be the current one.
  function setKyc ({ member, status, attempt, attemptId, documentId, selfieId } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!KYC_STATUSES.includes(status)) throw new TypeError('status must be one of ' + KYC_STATUSES.join(', '))
      if (attempt !== undefined && !validAttempt(attempt)) throw new TypeError('attempt must be a positive integer')
      checkOptionalId(attemptId, 'attemptId')
      checkOptionalId(documentId, 'documentId')
      checkOptionalId(selfieId, 'selfieId')
      return mutate(member, (cur) => {
        if (!cur || cur.subAccountId === null) return null
        const k = cur.kyc
        if (attempt !== undefined && attempt !== k.attempt) return null
        if (k.status === 'aprovado') return null
        let next
        let previous = previousOf(k)
        if (status === 'documentos' && RANK[k.status] === RANK.recusado) {
          if (k.attempt >= MAX_ATTEMPT) return null
          next = freshKyc(k.updatedAt)
          next.attempt = k.attempt + 1
          next.status = 'documentos'
          if (k.attemptId !== null) previous = [...previous, k.attemptId]
        } else if (RANK[status] < RANK[k.status]) {
          return null
        } else {
          next = copyKyc(k)
          next.status = status
        }
        if (attemptId !== undefined) {
          if (next.attemptId !== null && attemptId !== next.attemptId) previous = [...previous, next.attemptId]
          next.attemptId = attemptId
        }
        withPrevious(next, previous)
        if (documentId !== undefined) next.documentId = documentId
        if (selfieId !== undefined) next.selfieId = selfieId
        const same = next.attempt === k.attempt && next.status === k.status &&
          next.attemptId === k.attemptId && next.documentId === k.documentId && next.selfieId === k.selfieId &&
          JSON.stringify(previousOf(next)) === JSON.stringify(previousOf(k))
        if (same) return null
        // A new intent is stamped strictly after the previous change, so it
        // always beats a revert of the last one, even within one millisecond.
        next.updatedAt = isKycIntent(next)
          ? new Date(Math.max(now(), Date.parse(k.updatedAt) + 1)).toISOString()
          : stamp()
        cur.kyc = next
        return cur
      })
    })
  }

  // Undoes the submit intent when Hodle answered that it did not take the
  // submission (rate limit, key refused, our own input check): back to
  // documentos in the same attempt with both uploads kept. Allowed only on
  // the exact intent of `attempt`, so a recorded attempt id or a later
  // status is never touched.
  function revertKycIntent (member, attempt) {
    return enqueue(() => {
      checkMember(member)
      if (!validAttempt(attempt)) throw new TypeError('attempt must be a positive integer')
      return mutate(member, (cur) => {
        if (!cur || cur.subAccountId === null) return null
        const k = cur.kyc
        if (k.attempt !== attempt || !isKycIntent(k) || k.documentId === null || k.selfieId === null) return null
        const next = copyKyc(k)
        next.status = 'documentos'
        next.updatedAt = new Date(Math.max(now(), Date.parse(k.updatedAt) + 1)).toISOString()
        cur.kyc = next
        return cur
      })
    })
  }

  // The marker written before createWallet. It cannot be set once a wallet
  // exists: there is nothing left to guard.
  function setWalletUncertain (member, value) {
    return enqueue(() => {
      checkMember(member)
      if (typeof value !== 'boolean') throw new TypeError('value must be a boolean')
      return mutate(member, (cur) => {
        if (!cur || cur.subAccountId === null || cur.walletUncertain === value) return null
        if (value && cur.wallet !== null) return null
        mark(cur, 'wallet', value)
        return cur
      })
    })
  }

  // Every createWallet at Hodle mints a new wallet, so the first one stored
  // wins forever and later calls change nothing. Storing it clears the
  // marker. A member without a subaccount has nothing to attach it to. A
  // wallet id or wrapped key already held by another member is refused with
  // { conflict: true } and never stored.
  function setWallet ({ member, id, address, protectedSymmetricKey } = {}) {
    return enqueue(() => {
      checkMember(member)
      if (!validId(id)) throw new TypeError('id must be an id')
      if (!validAddress(address)) throw new TypeError('address must be 0x and 40 lowercase hex characters')
      if (!validPsk(protectedSymmetricKey)) throw new TypeError('protectedSymmetricKey is not valid')
      return mutate(member, (cur, base) => {
        if (!cur || cur.subAccountId === null || cur.wallet !== null) return null
        const taken = (e) => e.wallet !== null &&
          (e.wallet.id === id || e.wallet.protectedSymmetricKey === protectedSymmetricKey)
        if (ownedByOther(base, member, taken)) return CONFLICT
        cur.wallet = { id, address, protectedSymmetricKey, createdAt: stamp() }
        if (cur.walletUncertain) mark(cur, 'wallet', false)
        return cur
      })
    })
  }

  // True when it wrote. Never throws, never writes a file it would not have
  // written.
  function heal () {
    return enqueue(() => {
      if (failed || readOnly || !guard()) return false
      let disk, next
      try {
        disk = readState(file)
        next = merge(state, disk)
      } catch {
        failed = true
        return false
      }
      if (dirty || canonical(next) !== canonical(disk || emptyState())) {
        persist(next)
        return true
      }
      state = next
      return false
    }).catch(() => false)
  }

  function get (member) {
    checkMember(member)
    usable()
    const e = state.members[member]
    return e ? copyEntry(e) : null
  }

  // Scans the current state on every call, so a member created after open
  // (here or adopted from disk) is found. Webhook input lands here, so
  // anything that is not an id simply matches nobody.
  function bySubAccount (subAccountId) {
    usable()
    if (!validId(subAccountId)) return null
    for (const member of Object.keys(state.members)) {
      if (state.members[member].subAccountId === subAccountId) return member
    }
    return null
  }

  function stats () {
    usable()
    const kyc = {}
    for (const s of KYC_STATUSES) kyc[s] = 0
    const out = { members: 0, subaccounts: 0, subaccountUncertain: 0, wallets: 0, walletUncertain: 0, kyc }
    for (const e of Object.values(state.members)) {
      out.members++
      if (e.subAccountId !== null) out.subaccounts++
      if (e.subaccountUncertain) out.subaccountUncertain++
      if (e.wallet !== null) out.wallets++
      if (e.walletUncertain) out.walletUncertain++
      kyc[e.kyc.status]++
    }
    return out
  }

  return {
    get,
    intendSubaccount,
    clearSubaccountUncertain,
    create,
    setKyc,
    revertKycIntent,
    setWalletUncertain,
    setWallet,
    bySubAccount,
    stats,
    heal,
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openWalletStore,
  FILE,
  NETWORKS,
  KYC_STATUSES
}
