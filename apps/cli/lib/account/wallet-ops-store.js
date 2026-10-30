'use strict'

// The money ledger of the optional payments account (Hodle): ONE sidecar
// file, <dataDir>/wallet-ops.json (mode 0o600), always replaced whole through
// writeJsonAtomic (packages/core/lib/store.js), kept apart from wallet.json
// so the identifiers and wrapped keys there are never rewritten by the busy
// path of payments.
//
// Each operation is keyed by its externalId, 'var-' plus the first 32 hex
// characters of sha256(member + ':' + kind + ':' + opId), where opId is
// minted by the client for one tap. The same tap always lands on the same
// row and the same Hodle externalId, so a repeated request can never become
// a second movement; a repeated opId whose terms differ is reported as
// divergent and never merged into the stored row.
//
// The row is written BEFORE the provider call. A crash or a lost answer
// leaves it 'enviado' or 'incerto', and the service never sends such an
// operation again: only a provider read (polling, a statement match or a
// webhook) moves it on. The Varanda fee is a separate leg with its own
// status, also written before its dispatch ('enviada'); a fee that could not
// be collected stays 'pendente' and is re-presented, with the same
// reference, only inside a later send the member signs.
//
// What a row may hold is closed: kind, status, amounts, the fee leg, the
// provider id, a transaction hash, a MASKED destination (the last 4
// characters of a Pix key, '@nome', or '0x..' plus the last 6 hex of an
// address), the dispute flag and the support flag. Never a PIN, CPF, full
// Pix key, QR code, name or balance: put() refuses any other key and any
// destination that is not one of the masked forms, and a file with any
// other key is unavailable.
//
// Statuses only move forward. concluido, falhou and devolvido are final,
// except concluido -> devolvido (a settled Pix can still be reversed) and,
// for deposits, falhou, which is not final (Hodle keeps going until it
// refunds the payer). 'expirado' exists only for deposits and is not final
// either: a late Pix is honoured. 'incerto' may become anything. Disputes
// are a flag beside the status and never change it. 'cobrada' is the only
// final fee status.
//
// As in wallet-store: opening never creates anything, a readOnly store never
// writes, validation is total (a file this module would not have written is
// never rewritten and every method then throws { code: 'indisponivel' }),
// bad argument shapes throw TypeError, every write runs in one in-process
// queue and first re-reads and merges the file, and memory holds only what
// was durably written. One known limit of the merge: after a lost lock, a
// holder whose memory is stale can bring back rows another holder pruned;
// they are final rows and the next prune removes them again. The same lost
// lock can also keep the later copy's hodleFeeCents, keep the first known
// providerId, txHash or fee.reference over the other copy's, and restore a
// suporte flag the operator cleared; all of these are accepted, like the
// pruned rows.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'wallet-ops.json'
const VERSION = 1
const KINDS = Object.freeze(['deposit', 'payout', 'transfer', 'crypto', 'swap'])
const STATUSES = Object.freeze(['enviado', 'incerto', 'pendente', 'expirado', 'concluido', 'falhou', 'devolvido'])
const FEE_STATUSES = Object.freeze(['nenhuma', 'pendente', 'enviada', 'incerta', 'cobrada'])
const DISPUTES = Object.freeze(['aberta', 'aceita', 'rejeitada', 'cancelada'])
const ASSETS = Object.freeze(['BRLA', 'USDC'])
const FEE_ASSETS = Object.freeze(['BRL', 'USDC'])

const ENTRY_KEYS = [
  'member', 'kind', 'status', 'cents', 'hodleFeeCents', 'asset', 'source', 'amountMicros',
  'fee', 'providerId', 'txHash', 'to', 'dispute', 'suporte',
  'pendingFeeCents', 'pendingFeeRef', 'totalDebitCents', 'createdAt', 'updatedAt'
]
const FEE_KEYS = ['asset', 'cents', 'status', 'txHash', 'reference']
// What put() accepts: the entry minus what the store owns (timestamps, the
// dispute and the support flag) plus the externalId.
const PUT_KEYS = new Set(['externalId', ...ENTRY_KEYS.filter((k) => !['createdAt', 'updatedAt', 'dispute', 'suporte'].includes(k))])
const PUT_FEE_KEYS = new Set(FEE_KEYS)
const SET_FEE_KEYS = new Set(['status', 'txHash', 'reference'])

const EXTERNAL_ID_RE = /^var-[0-9a-f]{32}$/
const OP_ID_RE = /^[A-Za-z0-9_-]{22,43}$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const REF_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const TX_RE = /^0x[0-9a-f]{64}$/
const PIX_MASK_RE = /^\*{3}[A-Za-z0-9@.+_-]{4}$/
const NAME_MASK_RE = /^@[a-z][a-z0-9_]{2,19}$/
const ADDRESS_MASK_RE = /^0x\.\.[0-9a-f]{6}$/
const MAX_CENTS = 1e10
const MAX_MICROS = 1e15

const LIST_DEFAULT = 20
const LIST_MAX = 50
const PENDING_FEES_MAX = 20
const PRUNE_AGE_MS = 90 * 24 * 3600 * 1000
const PRUNE_CAP = 20000

// Allowed moves of the main status, per origin. 'incerto' may become
// anything; the deposit-only moves are added in canMove.
const MOVES = Object.freeze({
  enviado: ['incerto', 'pendente', 'concluido', 'falhou', 'devolvido'],
  incerto: ['enviado', 'pendente', 'expirado', 'concluido', 'falhou', 'devolvido'],
  pendente: ['concluido', 'falhou', 'devolvido'],
  expirado: ['pendente', 'concluido', 'falhou', 'devolvido'],
  concluido: ['devolvido'],
  falhou: [],
  devolvido: []
})
const DEPOSIT_MOVES = Object.freeze({
  enviado: ['expirado'],
  pendente: ['expirado'],
  falhou: ['concluido', 'devolvido']
})
const FEE_MOVES = Object.freeze({
  nenhuma: [],
  pendente: ['enviada', 'incerta', 'cobrada'],
  enviada: ['pendente', 'incerta', 'cobrada'],
  incerta: ['pendente', 'enviada', 'cobrada'],
  cobrada: []
})
const DISPUTE_MOVES = Object.freeze({
  null: ['aberta', 'aceita', 'rejeitada', 'cancelada'],
  aberta: ['aceita', 'rejeitada', 'cancelada'],
  aceita: [],
  rejeitada: [],
  cancelada: []
})
// The main status under which a fee is owed and may be collected: Varanda
// charges a Pix fee only once Hodle reports the payout concluded (owner
// decision 2026-10-30).
const FEE_OWED = Object.freeze(['concluido'])
// Principals that may still conclude, whose fee stays reserved in the wallet.
const FEE_RESERVED = Object.freeze(['enviado', 'incerto', 'pendente', 'concluido'])
// Fee statuses whose money must stay reserved in the wallet.
const OUTSTANDING_FEE = Object.freeze(['pendente', 'enviada', 'incerta'])
// Kinds that take money out of the member's wallet.
const DEBIT_KINDS = Object.freeze(['payout', 'transfer', 'crypto', 'swap'])

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

function validExternalId (s) {
  return typeof s === 'string' && EXTERNAL_ID_RE.test(s)
}

function intIn (n, min, max) {
  return Number.isSafeInteger(n) && n >= min && n <= max
}

function idOrNull (s) {
  return s === null || (typeof s === 'string' && ID_RE.test(s))
}

function refOrNull (s) {
  return s === null || (typeof s === 'string' && REF_RE.test(s))
}

function txOrNull (s) {
  return s === null || (typeof s === 'string' && TX_RE.test(s))
}

// A run of 11 or more digits is a CPF or a phone number whatever else
// surrounds it, so it is refused before any pattern is tried.
function validTo (kind, to) {
  if (to === null) return true
  if (typeof to !== 'string' || /[0-9]{11}/.test(to)) return false
  if (kind === 'payout') return PIX_MASK_RE.test(to)
  if (kind === 'transfer') return NAME_MASK_RE.test(to)
  if (kind === 'crypto') return ADDRESS_MASK_RE.test(to)
  return false
}

// A swap, or a USDC send funded from BRLA (converted at send time), rides on
// a Hodle swap whose failure strands money that only the operator can sort
// out.
function swapBacked (e) {
  return e.kind === 'swap' || (e.kind === 'crypto' && e.asset === 'USDC' && e.source === 'BRLA')
}

function isFinal (e) {
  if (e.status === 'falhou') return e.kind !== 'deposit'
  return e.status === 'concluido' || e.status === 'devolvido'
}

function canMove (kind, from, to) {
  if (from === to) return false
  if (to === 'expirado' && kind !== 'deposit') return false
  if (MOVES[from].includes(to)) return true
  return kind === 'deposit' && has(DEPOSIT_MOVES, from) && DEPOSIT_MOVES[from].includes(to)
}

function canMoveFee (from, to) {
  return from !== to && FEE_MOVES[from].includes(to)
}

function canMoveDispute (from, to) {
  return from !== to && DISPUTE_MOVES[String(from)].includes(to)
}

// The Varanda fee is charged in what the operation spends: USDC micros for
// a swap and for a USDC send paid from the USDC balance, centavos otherwise
// (a USDC send funded from BRLA spends BRLA).
function feeAsset (e) {
  if (e.kind === 'swap') return 'USDC'
  if (e.kind === 'crypto' && e.asset === 'USDC' && e.source === 'USDC') return 'USDC'
  return 'BRL'
}

function validFee (f, e) {
  return isPlainObject(f) &&
    exactKeys(f, FEE_KEYS) &&
    f.asset === feeAsset(e) &&
    intIn(f.cents, 0, MAX_CENTS) &&
    FEE_STATUSES.includes(f.status) &&
    (f.status === 'nenhuma') === (f.cents === 0) &&
    txOrNull(f.txHash) &&
    refOrNull(f.reference)
}

// Per-kind shape. BRLA kinds carry no micros and no source; a swap converts
// received USDC, so it has micros, no reais and no destination.
function validKindShape (e) {
  switch (e.kind) {
    case 'deposit':
    case 'payout':
    case 'transfer':
      return e.asset === 'BRLA' && e.source === null && e.amountMicros === null
    case 'swap':
      return e.asset === 'USDC' && e.source === null && intIn(e.amountMicros, 1, MAX_MICROS) &&
        e.cents === 0 && e.to === null
    case 'crypto':
      if (e.asset === 'BRLA') return e.source === 'BRLA' && e.amountMicros === null
      return e.asset === 'USDC' && ASSETS.includes(e.source) && intIn(e.amountMicros, 1, MAX_MICROS)
    default:
      return false
  }
}

function validEntry (e) {
  return isPlainObject(e) &&
    exactKeys(e, ENTRY_KEYS) &&
    validMember(e.member) &&
    KINDS.includes(e.kind) &&
    STATUSES.includes(e.status) &&
    (e.status !== 'expirado' || e.kind === 'deposit') &&
    intIn(e.cents, 0, MAX_CENTS) &&
    intIn(e.hodleFeeCents, 0, MAX_CENTS) &&
    validKindShape(e) &&
    validFee(e.fee, e) &&
    idOrNull(e.providerId) &&
    txOrNull(e.txHash) &&
    validTo(e.kind, e.to) &&
    (e.dispute === null || DISPUTES.includes(e.dispute)) &&
    typeof e.suporte === 'boolean' &&
    !(e.suporte && !(swapBacked(e) && e.status === 'falhou')) &&
    intIn(e.pendingFeeCents, 0, MAX_CENTS) &&
    refOrNull(e.pendingFeeRef) &&
    (e.pendingFeeRef === null) === (e.pendingFeeCents === 0) &&
    intIn(e.totalDebitCents, 0, MAX_CENTS * 4) &&
    isCanonicalIso(e.createdAt) &&
    isCanonicalIso(e.updatedAt) &&
    e.createdAt <= e.updatedAt
}

function copyFee (f) {
  return { asset: f.asset, cents: f.cents, status: f.status, txHash: f.txHash, reference: f.reference }
}

function copyEntry (e) {
  const out = {}
  for (const k of ENTRY_KEYS) out[k] = e[k]
  out.fee = copyFee(e.fee)
  return out
}

// The terms a client signed. A repeated opId must match them exactly; what
// the provider reports later (status, ids, Hodle's deposit fee) is not part
// of them.
function sameTerms (a, b) {
  return a.member === b.member && a.kind === b.kind && a.cents === b.cents &&
    a.asset === b.asset && a.source === b.source && a.amountMicros === b.amountMicros &&
    a.to === b.to && a.fee.asset === b.fee.asset && a.fee.cents === b.fee.cents &&
    a.pendingFeeCents === b.pendingFeeCents && a.pendingFeeRef === b.pendingFeeRef &&
    a.totalDebitCents === b.totalDebitCents
}

function emptyState () {
  return { v: VERSION, ops: Object.create(null) }
}

function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'ops']) || obj.v !== VERSION) throw new Error('operações inválidas')
  if (!isPlainObject(obj.ops)) throw new Error('operações inválidas')
  const state = emptyState()
  for (const [id, entry] of Object.entries(obj.ops)) {
    if (!validExternalId(id) || !validEntry(entry)) throw new Error('operações inválidas')
    state.ops[id] = copyEntry(entry)
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
  if (!st.isFile()) throw new Error('operações inválidas')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function toJson (state) {
  const ops = {}
  for (const id of Object.keys(state.ops).sort()) ops[id] = copyEntry(state.ops[id])
  return { v: VERSION, ops }
}

function canonical (state) {
  return JSON.stringify(toJson(state))
}

function copyState (state) {
  const out = emptyState()
  for (const [id, e] of Object.entries(state.ops)) out.ops[id] = copyEntry(e)
  return out
}

function tieBreak (a, b) {
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b
}

// Picks between two values of one field: the one the other can move to,
// else (both ways or neither) the copy changed later.
function pickMoved (av, bv, aAt, bAt, move, a, b) {
  if (av === bv) return av
  const ab = move(av, bv)
  const ba = move(bv, av)
  if (ab && !ba) return bv
  if (ba && !ab) return av
  if (aAt !== bAt) return aAt > bAt ? av : bv
  return tieBreak(a, b) === a ? av : bv
}

function firstNonNull (won, lost) {
  return won !== null ? won : lost
}

// Two copies of one operation after a lost lock. With different terms only
// one tap can be true: the earlier row is kept whole. Otherwise each field
// keeps its furthest value.
function mergeEntry (a, b) {
  if (!sameTerms(a, b)) {
    if (a.createdAt !== b.createdAt) return copyEntry(a.createdAt < b.createdAt ? a : b)
    return copyEntry(tieBreak(a, b))
  }
  const later = a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? a : b) : tieBreak(a, b)
  const earlier = later === a ? b : a
  const out = copyEntry(later)
  out.status = pickMoved(a.status, b.status, a.updatedAt, b.updatedAt, (x, y) => canMove(a.kind, x, y), a, b)
  out.fee.status = pickMoved(a.fee.status, b.fee.status, a.updatedAt, b.updatedAt, canMoveFee, a, b)
  out.fee.txHash = firstNonNull(later.fee.txHash, earlier.fee.txHash)
  out.fee.reference = firstNonNull(later.fee.reference, earlier.fee.reference)
  out.dispute = pickMoved(a.dispute, b.dispute, a.updatedAt, b.updatedAt, canMoveDispute, a, b)
  out.providerId = firstNonNull(later.providerId, earlier.providerId)
  out.txHash = firstNonNull(later.txHash, earlier.txHash)
  out.createdAt = a.createdAt < b.createdAt ? a.createdAt : b.createdAt
  const failedSide = a.status === 'falhou' && b.status === 'falhou' ? later : (a.status === 'falhou' ? a : b)
  out.suporte = failedSide.suporte && swapBacked(out) && out.status === 'falhou'
  return out
}

function merge (mem, disk) {
  const out = copyState(mem)
  if (disk) {
    for (const [id, e] of Object.entries(disk.ops)) {
      out.ops[id] = out.ops[id] ? mergeEntry(out.ops[id], e) : copyEntry(e)
    }
  }
  return out
}

function checkExternalId (id) {
  if (!validExternalId(id)) throw new TypeError('externalId must be var- and 32 lowercase hex characters')
}

function checkMember (member) {
  if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
}

function externalIdFor (member, kind, opId) {
  checkMember(member)
  if (!KINDS.includes(kind)) throw new TypeError('kind must be one of ' + KINDS.join(', '))
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) throw new TypeError('opId must match ' + OP_ID_RE)
  const hex = crypto.createHash('sha256').update(member + ':' + kind + ':' + opId).digest('hex')
  return 'var-' + hex.slice(0, 32)
}

// Builds the stored row from put() input, filling the defaults. Unknown keys
// are refused so nothing outside the closed list can be stored.
// The closed-key check, done before the queue so a bad shape is a TypeError
// whatever the state of the file.
function checkInputKeys (input) {
  if (!isPlainObject(input)) throw new TypeError('entry must be an object')
  for (const k of Object.keys(input)) {
    if (!PUT_KEYS.has(k)) throw new TypeError('unknown entry key ' + k)
  }
  checkExternalId(input.externalId)
  if (has(input, 'fee')) {
    if (!isPlainObject(input.fee)) throw new TypeError('fee must be an object')
    for (const k of Object.keys(input.fee)) {
      if (!PUT_FEE_KEYS.has(k)) throw new TypeError('unknown fee key ' + k)
    }
  }
}

// On an update, a field the input leaves out keeps the stored value, so a
// status read that does not repeat Hodle's fee or ids never erases them.
// Defaults apply only when the row is created.
function fillFromStored (input, cur) {
  const out = { ...input }
  for (const k of PUT_KEYS) {
    if (k !== 'externalId' && k !== 'fee' && !has(input, k)) out[k] = cur[k]
  }
  out.fee = has(input, 'fee') ? { ...input.fee } : {}
  for (const k of FEE_KEYS) {
    if (!has(out.fee, k)) out.fee[k] = cur.fee[k]
  }
  return out
}

function entryFromInput (input, at) {
  checkInputKeys(input)
  checkMember(input.member)
  if (!KINDS.includes(input.kind)) throw new TypeError('kind must be one of ' + KINDS.join(', '))
  if (!isPlainObject(input.fee)) throw new TypeError('fee must be an object')
  for (const k of Object.keys(input.fee)) {
    if (!PUT_FEE_KEYS.has(k)) throw new TypeError('unknown fee key ' + k)
  }
  const kind = input.kind
  const pick = (k, dflt) => has(input, k) ? input[k] : dflt
  const e = {
    member: input.member,
    kind,
    status: input.status,
    cents: input.cents,
    hodleFeeCents: pick('hodleFeeCents', 0),
    asset: pick('asset', kind === 'swap' ? 'USDC' : 'BRLA'),
    source: pick('source', kind === 'crypto' ? 'BRLA' : null),
    amountMicros: pick('amountMicros', null),
    fee: {
      asset: has(input.fee, 'asset') ? input.fee.asset : null,
      cents: input.fee.cents,
      status: input.fee.status,
      txHash: has(input.fee, 'txHash') ? input.fee.txHash : null,
      reference: has(input.fee, 'reference') ? input.fee.reference : null
    },
    providerId: pick('providerId', null),
    txHash: pick('txHash', null),
    to: pick('to', null),
    dispute: null,
    suporte: false,
    pendingFeeCents: pick('pendingFeeCents', 0),
    pendingFeeRef: pick('pendingFeeRef', null),
    totalDebitCents: pick('totalDebitCents', 0),
    createdAt: at,
    updatedAt: at
  }
  if (e.fee.asset === null) e.fee.asset = feeAsset(e)
  if (!FEE_ASSETS.includes(e.fee.asset)) throw new TypeError('fee.asset must be one of ' + FEE_ASSETS.join(', '))
  if (swapBacked(e) && e.status === 'falhou') e.suporte = true
  if (!validTo(kind, e.to)) throw new TypeError('to must be a masked destination')
  if (!validEntry(e)) throw new TypeError('entry is not valid')
  return e
}

function openWalletOpsStore (dataDir, { now = Date.now, guard = () => true, readOnly = false } = {}) {
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

  // Strictly after the previous change, so the merge can always tell which
  // copy is newer.
  function stampAfter (prev) {
    return new Date(Math.max(now(), Date.parse(prev) + 1)).toISOString()
  }

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

  // Runs `change` on a copy of the merged state of memory and disk. It
  // mutates that copy and returns the answer; answer.changed decides whether
  // the copy is written. With no change a stale disk is still brought up to
  // date.
  function mutate (change) {
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
    const next = copyState(base)
    const answer = change(next)
    if (!answer.changed) {
      if (stale) persist(base)
      else state = base
      return answer
    }
    persist(next)
    return answer
  }

  // Inserts the row, or moves an existing one on. On an existing row only
  // the status (forward), hodleFeeCents, a missing providerId or txHash and
  // the support flag are taken from `input`; the fee leg and the dispute
  // have their own methods. Different terms for the same externalId answer
  // { changed: false, divergent: true } and write nothing.
  function put (input) {
    return enqueue(() => {
      checkInputKeys(input)
      const at = new Date(now()).toISOString()
      const id = input.externalId
      return mutate((next) => {
        const cur = next.ops[id]
        if (!cur) {
          next.ops[id] = entryFromInput(input, at)
          return { changed: true }
        }
        const fresh = entryFromInput(fillFromStored(input, cur), at)
        if (!sameTerms(cur, fresh)) return { changed: false, divergent: true }
        const out = copyEntry(cur)
        if (canMove(cur.kind, cur.status, fresh.status)) out.status = fresh.status
        if (fresh.hodleFeeCents !== cur.hodleFeeCents) out.hodleFeeCents = fresh.hodleFeeCents
        if (cur.providerId === null) out.providerId = fresh.providerId
        if (cur.txHash === null) out.txHash = fresh.txHash
        // The support flag is set when a swap fails and cleared only by
        // the operator (clearSupport), never by a later put.
        out.suporte = swapBacked(out) && out.status === 'falhou' &&
          (cur.suporte || cur.status !== 'falhou')
        if (JSON.stringify(out) === JSON.stringify(cur)) return { changed: false }
        out.updatedAt = stampAfter(cur.updatedAt)
        next.ops[id] = out
        return { changed: true }
      })
    })
  }

  // Moves the fee leg: status forward ('cobrada' is final), txHash and
  // reference kept once known.
  function setFee (externalId, fields) {
    return enqueue(() => {
      checkExternalId(externalId)
      if (!isPlainObject(fields)) throw new TypeError('fee fields must be an object')
      for (const k of Object.keys(fields)) {
        if (!SET_FEE_KEYS.has(k)) throw new TypeError('unknown fee key ' + k)
      }
      if (has(fields, 'status') && !FEE_STATUSES.includes(fields.status)) {
        throw new TypeError('fee.status must be one of ' + FEE_STATUSES.join(', '))
      }
      if (has(fields, 'txHash') && !txOrNull(fields.txHash)) throw new TypeError('fee.txHash must be a transaction hash or null')
      if (has(fields, 'reference') && !refOrNull(fields.reference)) throw new TypeError('fee.reference must be a reference or null')
      return mutate((next) => {
        const cur = next.ops[externalId]
        if (!cur) return { changed: false, missing: true }
        const out = copyEntry(cur)
        if (has(fields, 'status') && canMoveFee(cur.fee.status, fields.status)) out.fee.status = fields.status
        if (cur.fee.txHash === null && has(fields, 'txHash')) out.fee.txHash = fields.txHash
        if (cur.fee.reference === null && has(fields, 'reference')) out.fee.reference = fields.reference
        if (JSON.stringify(out) === JSON.stringify(cur)) return { changed: false }
        out.updatedAt = stampAfter(cur.updatedAt)
        next.ops[externalId] = out
        return { changed: true }
      })
    })
  }

  // A dispute only moves forward (aberta, then one decision), so a delivery
  // that arrives late never reopens a decided dispute. The status is never
  // touched.
  function setDispute (externalId, value) {
    return enqueue(() => {
      checkExternalId(externalId)
      if (!DISPUTES.includes(value)) throw new TypeError('dispute must be one of ' + DISPUTES.join(', '))
      return mutate((next) => {
        const cur = next.ops[externalId]
        if (!cur) return { changed: false, missing: true }
        if (!canMoveDispute(cur.dispute, value)) return { changed: false }
        const out = copyEntry(cur)
        out.dispute = value
        out.updatedAt = stampAfter(cur.updatedAt)
        next.ops[externalId] = out
        return { changed: true }
      })
    })
  }

  // For the operator, once a stranded swap has been sorted out.
  function clearSupport (externalId) {
    return enqueue(() => {
      checkExternalId(externalId)
      return mutate((next) => {
        const cur = next.ops[externalId]
        if (!cur) return { changed: false, missing: true }
        if (!cur.suporte) return { changed: false }
        const out = copyEntry(cur)
        out.suporte = false
        out.updatedAt = stampAfter(cur.updatedAt)
        next.ops[externalId] = out
        return { changed: true }
      })
    })
  }

  // Removes final rows changed more than 90 days before `at`, then the
  // oldest final rows above the cap. A row whose fee may still move money,
  // with an open dispute or awaiting the operator is kept like a non-final
  // one.
  function prune (at) {
    return enqueue(() => {
      if (!Number.isFinite(at)) throw new TypeError('prune needs a time in milliseconds')
      return mutate((next) => {
        const prunable = Object.keys(next.ops)
          .filter((id) => removable(next.ops[id]))
          .sort((x, y) => byUpdated(next.ops[x], next.ops[y], x, y))
        let removed = 0
        let total = Object.keys(next.ops).length
        for (const id of prunable) {
          const old = Date.parse(next.ops[id].updatedAt) < at - PRUNE_AGE_MS
          if (!old && total <= PRUNE_CAP) break
          delete next.ops[id]
          removed++
          total--
        }
        return { changed: removed > 0, removed }
      })
    })
  }

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

  function view (id) {
    return { externalId: id, ...copyEntry(state.ops[id]) }
  }

  function get (externalId) {
    usable()
    if (!validExternalId(externalId)) return null
    return has(state.ops, externalId) ? view(externalId) : null
  }

  function listByMember (member, { limit = LIST_DEFAULT } = {}) {
    checkMember(member)
    if (!intIn(limit, 1, LIST_MAX)) throw new TypeError('limit must be an integer from 1 to ' + LIST_MAX)
    usable()
    return Object.keys(state.ops)
      .filter((id) => state.ops[id].member === member)
      .sort((x, y) => byCreated(state.ops[y], state.ops[x], y, x))
      .slice(0, limit)
      .map(view)
  }

  // The fees this member still owes, oldest first: only where the principal
  // was accepted and not undone.
  function pendingFees (member) {
    checkMember(member)
    usable()
    return Object.keys(state.ops)
      .filter((id) => {
        const e = state.ops[id]
        return e.member === member && (e.fee.status === 'pendente' || e.fee.status === 'incerta') &&
          FEE_OWED.includes(e.status)
      })
      .sort((x, y) => byCreated(state.ops[x], state.ops[y], x, y))
      .slice(0, PENDING_FEES_MAX)
      .map(view)
  }

  // Every BRL fee this member still owes or may still be paying, summed over
  // all its rows with no cap: what a new debit must leave in the wallet.
  // Memory holds every durably written row, so nothing is left out.
  function outstandingFees (member) {
    checkMember(member)
    usable()
    let cents = 0
    let count = 0
    for (const e of Object.values(state.ops)) {
      if (e.member !== member || e.fee.asset !== 'BRL' || !FEE_RESERVED.includes(e.status)) continue
      if (!OUTSTANDING_FEE.includes(e.fee.status)) continue
      cents += e.fee.cents
      count++
    }
    return { cents, count }
  }

  // Every debit of this member whose outcome is still unknown, oldest first,
  // across all its rows: a busy history must never hide one.
  function unresolvedDebits (member) {
    checkMember(member)
    usable()
    return Object.keys(state.ops)
      .filter((id) => {
        const e = state.ops[id]
        return e.member === member && DEBIT_KINDS.includes(e.kind) && (e.status === 'enviado' || e.status === 'incerto')
      })
      .sort((x, y) => byCreated(state.ops[x], state.ops[y], x, y))
      .map(view)
  }

  function stats () {
    usable()
    const byKind = {}
    const byStatus = {}
    const fees = {}
    for (const k of KINDS) byKind[k] = 0
    for (const s of STATUSES) byStatus[s] = 0
    for (const s of FEE_STATUSES) fees[s] = 0
    const out = { ops: 0, byKind, byStatus, fees, disputesOpen: 0, suporte: 0 }
    for (const e of Object.values(state.ops)) {
      out.ops++
      byKind[e.kind]++
      byStatus[e.status]++
      fees[e.fee.status]++
      if (e.dispute === 'aberta') out.disputesOpen++
      if (e.suporte) out.suporte++
    }
    return out
  }

  return {
    put,
    setFee,
    setDispute,
    clearSupport,
    get,
    listByMember,
    pendingFees,
    outstandingFees,
    unresolvedDebits,
    prune,
    stats,
    heal,
    fail () { failed = true },
    available () { return !failed }
  }
}

// A fee leg that may still move money: dispatched without a known answer, or
// owed on an accepted principal.
function feeOutstanding (e) {
  if (e.fee.status === 'enviada' || e.fee.status === 'incerta') return true
  return e.fee.status === 'pendente' && FEE_OWED.includes(e.status)
}

function removable (e) {
  return isFinal(e) && !feeOutstanding(e) && e.dispute !== 'aberta' && !e.suporte
}

function byCreated (a, b, x, y) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return x < y ? -1 : x > y ? 1 : 0
}

function byUpdated (a, b, x, y) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
  return x < y ? -1 : x > y ? 1 : 0
}

// Pure mappings from Hodle's provider statuses, for the poller and the
// webhook sink. Unknown values map to null and change nothing.

// Deposits: EXPIRED and FAILED are not final (a late Pix is honoured; a
// failed delivery ends in a refund).
function depositStatus (providerStatus) {
  switch (providerStatus) {
    case 'PENDING':
    case 'FIAT_PAID':
    case 'PROCESSING':
      return 'pendente'
    case 'COMPLETED':
      return 'concluido'
    case 'EXPIRED':
      return 'expirado'
    case 'FAILED':
      return 'falhou'
    case 'REFUNDED':
      return 'devolvido'
    default:
      return null
  }
}

function swapStatus (providerStatus) {
  switch (providerStatus) {
    case 'RUNNING':
      return { status: 'pendente', suporte: false }
    case 'COMPLETED':
      return { status: 'concluido', suporte: false }
    case 'FAILED':
    case 'STRANDED':
      return { status: 'falhou', suporte: true }
    default:
      return null
  }
}

const DISPUTE_EVENTS = Object.freeze({
  DISPUTE_CREATED: 'aberta',
  DISPUTE_ACCEPTED: 'aceita',
  DISPUTE_REJECTED: 'rejeitada',
  DISPUTE_CANCELED: 'cancelada'
})

function disputeValue (event) {
  return has(DISPUTE_EVENTS, event) ? DISPUTE_EVENTS[event] : null
}

// The operation a dispute is about, read from data.walletCharge.externalId.
// Only our own ids can match, so anything else is null.
function disputeTarget (data) {
  if (!isPlainObject(data) || !isPlainObject(data.walletCharge)) return null
  const id = data.walletCharge.externalId
  return validExternalId(id) ? id : null
}

function opaque (s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 256 && /^[\x21-\x7e]+$/.test(s)
}

// The deduplication identity of a webhook delivery, per event family:
// deposits by data.eventId, payouts by event + transactionId, KYC by event +
// attemptId (only the member's current attempt), disputes by event +
// endToEndId. null means the delivery cannot be deduplicated and is not
// acted on.
function eventKey (event, data, { currentAttemptId = null } = {}) {
  if (typeof event !== 'string' || !isPlainObject(data)) return null
  if (event.startsWith('DEPOSIT_')) return opaque(data.eventId) ? 'deposit:' + data.eventId : null
  if (event.startsWith('PAYOUT_')) return opaque(data.transactionId) ? event + ':' + data.transactionId : null
  if (event.startsWith('KYC_')) {
    if (!opaque(data.attemptId) || data.attemptId !== currentAttemptId) return null
    return event + ':' + data.attemptId
  }
  if (has(DISPUTE_EVENTS, event)) return opaque(data.endToEndId) ? event + ':' + data.endToEndId : null
  return null
}

module.exports = {
  openWalletOpsStore,
  externalIdFor,
  depositStatus,
  swapStatus,
  disputeValue,
  disputeTarget,
  eventKey,
  FILE,
  KINDS,
  STATUSES,
  FEE_STATUSES,
  DISPUTES,
  OP_ID_RE,
  PRUNE_CAP
}
