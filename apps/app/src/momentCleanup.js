// Deleting the author's own expired momentos: candidate selection and the
// per-identity ledger. Pure: no React, no react-native, no Node built-ins.

import { MOMENT_MS } from './moments.js'
import {
  BUSY_MESSAGE, CLOSED_MESSAGE, GATE_MESSAGE, LOCKED_MESSAGE, NO_NODE_MESSAGE,
  SESSION_CLOSED_MESSAGE, TOO_MANY_MESSAGE
} from './outbox.js'
import { notSent } from './requestQueue.js'

export const MAX_PER_PASS = 4
export const MAX_TRIES = 3
// A day past the moment's own 24 h, so a clock ahead of the author's is never
// the reason a moment still on someone's strip disappears.
export const MARGIN_MS = 24 * 60 * 60 * 1000
export const LEDGER_CAP = 256
// packages/core/lib/moments.js MAX_PAST_MOMENTS: a full list may be truncated.
export const PAST_CAP = 16

const states = new Set(['pending', 'done', 'gone', 'failed', 'uncertain'])
const outcomes = new Set(['done', 'gone', 'failed', 'uncertain'])
const retryable = new Set(['pending', 'failed', 'uncertain'])
const terminal = new Set(['done', 'gone'])
// The same list as outbox.js RETRY_MESSAGES: the node refused before sending.
const refusals = new Set([GATE_MESSAGE, LOCKED_MESSAGE, BUSY_MESSAGE, CLOSED_MESSAGE, NO_NODE_MESSAGE, SESSION_CLOSED_MESSAGE, TOO_MANY_MESSAGE])
// One pass per identity per module lifetime, including planner recreation after lock.
// There is no reset or clock-based expiry; a new process loads a new module.
const begun = new Set()

function validIdentity (identity) {
  return typeof identity === 'string' && identity.length === 64 && /^[a-f0-9]+$/.test(identity)
}

function isCleanupRef (ref, identity = null) {
  if (typeof ref !== 'string') return false
  const parts = ref.split(':')
  if (parts.length !== 2 || !validIdentity(parts[0])) return false
  if (identity !== null && parts[0] !== identity) return false
  const seq = Number(parts[1])
  return Number.isSafeInteger(seq) && seq >= 1 && String(seq) === parts[1]
}

export function expiredOwn (past, identity, now) {
  try {
    if (!Array.isArray(past) || !validIdentity(identity) || !Number.isFinite(now)) return []
    const out = []
    const seen = new Set()
    for (const item of past) {
      if (!item || typeof item !== 'object') continue
      const { seq, ref, at } = item
      if (!Number.isSafeInteger(seq) || seq < 1 || ref !== identity + ':' + seq || seen.has(ref)) continue
      if (typeof at !== 'string') continue
      const start = Date.parse(at)
      if (!Number.isFinite(start) || start + MOMENT_MS + MARGIN_MS > now) continue
      seen.add(ref)
      out.push({ ref, seq, at, start })
    }
    out.sort((a, b) => a.start - b.start || a.seq - b.seq)
    return out.map(({ ref, seq, at }) => ({ ref, seq, at }))
  } catch {
    return []
  }
}

export function outcomeOf (err) {
  try {
    // A queued request was never sent, even when the drop copied an uncertain reason.
    if (notSent(err)) return 'refused'
    if (err && err.uncertain === true) return 'uncertain'
    if (err && (err.code === 'LOCKED' || err.code === 'CLOSED' || refusals.has(err.message))) return 'refused'
    if (err && err.message === 'referência inválida') return 'gone'
    return 'failed'
  } catch {
    // An error we cannot inspect may still have been applied.
    return 'uncertain'
  }
}

function validEntry (entry, identity) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry) &&
    Object.keys(entry).length === 3 && isCleanupRef(entry.ref, identity) &&
    Number.isSafeInteger(entry.tries) && entry.tries >= 1 && entry.tries <= MAX_TRIES &&
    states.has(entry.state)
}

function parseLedger (text, identity = null) {
  if (text === null) return new Map()
  if (typeof text !== 'string') return null
  let entries
  try { entries = JSON.parse(text) } catch { return null }
  if (!Array.isArray(entries) || entries.length > LEDGER_CAP) return null
  const ledger = new Map()
  for (const entry of entries) {
    if (!validEntry(entry, identity) || ledger.has(entry.ref)) return null
    ledger.set(entry.ref, { tries: entry.tries, state: entry.state })
  }
  return ledger
}

function serialize (ledger) {
  return JSON.stringify(Array.from(ledger, ([ref, { tries, state }]) => ({ ref, tries, state })))
}

function eligible (entry) {
  return entry === undefined || (entry.tries < MAX_TRIES && retryable.has(entry.state))
}

export function createCleanupPlanner ({ store, identity }) {
  if (!validIdentity(identity)) throw new Error('Identidade inválida.')

  function beginPass () {
    if (begun.has(identity)) return null
    begun.add(identity)
    let stopped = false
    let busy = false
    let count = 0
    let swept = false
    let selected = null
    const picked = new Set()
    const observed = new Set()

    // A ledger that loses a ref we saw in this pass was changed by someone else.
    async function readLedger () {
      const ledger = parseLedger(await store.read(identity), identity)
      if (!ledger || [...observed].some((ref) => !ledger.has(ref))) {
        throw new Error('Registro de momentos indisponível.')
      }
      for (const ref of ledger.keys()) observed.add(ref)
      return ledger
    }

    async function writeLedger (ledger) {
      await store.write(identity, serialize(ledger))
      observed.clear()
      for (const ref of ledger.keys()) observed.add(ref)
    }

    // Serialize the steps and stop the pass on the first failure.
    async function step (check, fn) {
      if (stopped || busy || !check()) throw new Error('Passagem de momentos indisponível.')
      busy = true
      try {
        return await fn()
      } catch (err) {
        stopped = true
        throw err
      } finally {
        busy = false
      }
    }

    // A moment that left an untruncated `past` was deleted or is no longer
    // an expired live moment, so retrying it can only fail.
    // listPast must throw on any failed or malformed read: a short list retires entries as 'gone'.
    function settleStale (past) {
      return step(() => !swept && count === 0 && selected === null, async () => {
        swept = true
        if (!Array.isArray(past) || past.length >= PAST_CAP) return 0
        const listed = new Set(past.map((item) => item && typeof item === 'object' ? item.ref : null))
        const ledger = await readLedger()
        let settled = 0
        for (const [ref, entry] of ledger) {
          if (terminal.has(entry.state) || listed.has(ref)) continue
          ledger.set(ref, { tries: entry.tries, state: 'gone' })
          settled++
        }
        if (settled > 0) await writeLedger(ledger)
        return settled
      })
    }

    async function nextStep (candidates) {
      if (stopped || busy || selected || count >= MAX_PER_PASS) return null
      busy = true
      try {
        const ledger = await readLedger()
        if (!Array.isArray(candidates)) return null
        const candidate = candidates.find((item) => item && isCleanupRef(item.ref, identity) &&
          !picked.has(item.ref) && eligible(ledger.get(item.ref)))
        if (!candidate) return null
        selected = { ref: candidate.ref, prior: ledger.get(candidate.ref), claimed: false }
        picked.add(candidate.ref)
        count++
        return candidate
      } catch {
        stopped = true
        return null
      } finally {
        busy = false
      }
    }

    // Await this before sending moment.delete.
    function claim (ref) {
      return step(() => selected !== null && selected.ref === ref && !selected.claimed, async () => {
        const ledger = await readLedger()
        const entry = ledger.get(ref)
        const prior = selected.prior
        if (!eligible(entry) || (entry === undefined) !== (prior === undefined) ||
          (entry && (entry.tries !== prior.tries || entry.state !== prior.state))) {
          throw new Error('Momento já reservado.')
        }
        if (entry === undefined && ledger.size >= LEDGER_CAP) {
          const evict = [...ledger].find(([, value]) => terminal.has(value.state))
          if (!evict) throw new Error('Registro de momentos cheio.')
          ledger.delete(evict[0])
        }
        ledger.set(ref, { tries: entry === undefined ? 1 : entry.tries + 1, state: 'pending' })
        await writeLedger(ledger)
        selected.claimed = true
      })
    }

    async function pendingLedger (ref) {
      const ledger = await readLedger()
      const entry = ledger.get(ref)
      const tries = selected.prior === undefined ? 1 : selected.prior.tries + 1
      if (!entry || entry.state !== 'pending' || entry.tries !== tries) {
        throw new Error('Reserva de momento indisponível.')
      }
      return ledger
    }

    function settle (ref, outcome) {
      return step(() => selected !== null && selected.ref === ref && selected.claimed && outcomes.has(outcome), async () => {
        const ledger = await pendingLedger(ref)
        ledger.set(ref, { tries: ledger.get(ref).tries, state: outcome })
        await writeLedger(ledger)
        selected = null
      })
    }

    // Nothing was sent: give the try back.
    function release (ref) {
      return step(() => selected !== null && selected.ref === ref && selected.claimed, async () => {
        const ledger = await pendingLedger(ref)
        const prior = selected.prior
        if (prior === undefined) ledger.delete(ref)
        else ledger.set(ref, { tries: prior.tries, state: prior.state })
        await writeLedger(ledger)
        selected = null
      })
    }

    return { settleStale, nextStep, claim, settle, release }
  }

  return { beginPass }
}

// Serialize the shared native file so writes for different identities cannot erase each other.
export function createCleanupFileStore ({ read, write }) {
  let queue = Promise.resolve()
  function run (fn) {
    const result = queue.then(fn)
    queue = result.catch(() => {})
    return result
  }

  async function readDocument () {
    const text = await read()
    if (text === null) return Object.create(null)
    if (typeof text !== 'string') throw new Error('Registro de momentos indisponível.')
    const document = JSON.parse(text)
    if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !Object.keys(document).every(validIdentity)) throw new Error('Registro de momentos inválido.')
    return document
  }

  return {
    read: (identity) => run(async () => {
      if (!validIdentity(identity)) throw new Error('Identidade inválida.')
      const document = await readDocument()
      return Object.hasOwn(document, identity) ? JSON.stringify(document[identity]) : null
    }),
    write: (identity, text) => run(async () => {
      if (!validIdentity(identity) || text === null || !parseLedger(text, identity)) throw new Error('Registro de momentos inválido.')
      const document = await readDocument()
      document[identity] = JSON.parse(text)
      await write(JSON.stringify(document))
    })
  }
}
