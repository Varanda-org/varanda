'use strict'

// What the member decided about the depoimentos they received: kept
// privately or declined. The list syncs between the member's devices inside
// the encrypted seen document (lib/seen-blob.js), so a decision made on one
// device holds on every other.
// Pure: no I/O and no clock, and it never throws on stored data.
//
// Entries are { from, seq, state, t }, one per testimonial (id from:seq),
// t in unix seconds. Per id the newer entry wins.

const { TESTIMONIAL_KEPT_MAX, TESTIMONIAL_DECLINED_MAX, TESTIMONIAL_PENDING_MAX } = require('@varanda/rpc')

const HEX64 = /^[0-9a-f]{64}$/
const U32_MAX = 4294967295
const STATES = ['kept', 'declined']

function isSeq (n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= U32_MAX
}

function isRef (v) {
  return v !== null && typeof v === 'object' && typeof v.from === 'string' && HEX64.test(v.from) && isSeq(v.seq)
}

function validEntry (e) {
  return isRef(e) && STATES.includes(e.state) && Number.isSafeInteger(e.t) && e.t >= 0 && e.t <= U32_MAX
}

function decisionId (from, seq) {
  return from + ':' + seq
}

// The newer entry wins. At equal times kept wins: it is the state the member
// can still undo, since a declined testimonial is listed nowhere. The result
// does not depend on the order the entries arrive in.
function newer (a, b) {
  if (a.t !== b.t) return a.t > b.t ? a : b
  return a.state === 'kept' ? a : b
}

function oldestFirst (a, b) {
  return a.t - b.t || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || a.seq - b.seq
}

// Canonical form: valid entries only, one per id, oldest first, kept and
// declined each cut to their cap (the newest stay).
function normalizeDecisions (list) {
  const byId = new Map()
  for (const e of Array.isArray(list) ? list : []) {
    if (!validEntry(e)) continue
    const id = decisionId(e.from, e.seq)
    const entry = { from: e.from, seq: e.seq, state: e.state, t: e.t }
    const held = byId.get(id)
    byId.set(id, held === undefined ? entry : newer(held, entry))
  }
  const all = [...byId.values()].sort(oldestFirst)
  const kept = all.filter((e) => e.state === 'kept').slice(-TESTIMONIAL_KEPT_MAX)
  const declined = all.filter((e) => e.state === 'declined').slice(-TESTIMONIAL_DECLINED_MAX)
  return kept.concat(declined).sort(oldestFirst)
}

function sameList (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.from !== y.from || x.seq !== y.seq || x.state !== y.state || x.t !== y.t) return false
  }
  return true
}

// -> { entries, changed }. A decision gets a time above the testimonial's
// last one, so it wins even on a device whose clock runs behind. With ifNew
// it is recorded only when nothing is held for that testimonial, at t = 0, so
// a migrated legacy hide loses to any decision made on purpose.
function applyDecision (list, decision, nowSec, opts) {
  const entries = normalizeDecisions(list)
  const unchanged = { entries, changed: false }
  try {
    const ifNew = opts !== null && typeof opts === 'object' && opts.ifNew === true
    if (!isRef(decision) || !STATES.includes(decision.state)) return unchanged
    if (!Number.isSafeInteger(nowSec) || nowSec < 0) return unchanged
    const { from, seq, state } = decision
    const held = entries.find((e) => e.from === from && e.seq === seq)
    if (held !== undefined && (ifNew || held.state === state)) return unchanged
    let t = 0
    if (!ifNew) {
      t = Math.max(nowSec, held === undefined ? 0 : held.t + 1)
      // At a full list a clock running behind must not make this the oldest
      // entry, which the cap would cut at once.
      const same = entries.filter((e) => e.state === state)
      const cap = state === 'kept' ? TESTIMONIAL_KEPT_MAX : TESTIMONIAL_DECLINED_MAX
      if (same.length >= cap) t = Math.max(t, same[0].t + 1)
      t = Math.min(t, U32_MAX)
    }
    const next = entries.filter((e) => e !== held)
    next.push({ from, seq, state, t })
    const out = normalizeDecisions(next)
    return { entries: out, changed: !sameList(out, entries) }
  } catch {
    return unchanged
  }
}

// Two devices' lists as one: commutative and idempotent, so devices that keep
// merging converge.
function mergeDecisions (a, b) {
  return normalizeDecisions([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])
}

function stateById (list) {
  const out = new Map()
  for (const e of normalizeDecisions(list)) out.set(decisionId(e.from, e.seq), e.state)
  return out
}

// The same decisions, whatever their times.
function sameDecisions (a, b) {
  const x = stateById(a)
  const y = stateById(b)
  if (x.size !== y.size) return false
  for (const [id, state] of x) if (y.get(id) !== state) return false
  return true
}

// The testimonials to read: every pointer not already shown, then every
// decided testimonial not already shown. State is never looked at, and no
// cap is applied here, so a seeder watching the reads cannot tell kept from
// declined.
function readRefs (pointers, entries, shownIds) {
  const shown = shownIds instanceof Set ? shownIds : new Set()
  const seen = new Set()
  const out = []
  const add = (r) => {
    if (!isRef(r)) return
    const id = decisionId(r.from, r.seq)
    if (shown.has(id) || seen.has(id)) return
    seen.add(id)
    out.push({ from: r.from, seq: r.seq })
  }
  for (const p of Array.isArray(pointers) ? pointers : []) add(p)
  for (const e of Array.isArray(entries) ? entries : []) if (validEntry(e)) add(e)
  return out
}

// Opened rows { from, seq, text, at } split for testimonial.pending: items are
// the pointed rows with no decision, in input order; kept are the rows kept,
// newest decision first. Declined rows are dropped.
function splitRows (rows, pointerIds, entries, opts) {
  const o = opts !== null && typeof opts === 'object' ? opts : {}
  const pendingMax = Number.isSafeInteger(o.pendingMax) && o.pendingMax >= 0 ? o.pendingMax : TESTIMONIAL_PENDING_MAX
  const keptMax = Number.isSafeInteger(o.keptMax) && o.keptMax >= 0 ? o.keptMax : TESTIMONIAL_KEPT_MAX
  const pointed = pointerIds instanceof Set ? pointerIds : new Set()
  const decided = new Map()
  normalizeDecisions(entries).forEach((e, i) => decided.set(decisionId(e.from, e.seq), { state: e.state, rank: i }))
  const items = []
  const kept = []
  const used = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRef(row)) continue
    const id = decisionId(row.from, row.seq)
    if (used.has(id)) continue
    used.add(id)
    const d = decided.get(id)
    if (d === undefined) {
      if (pointed.has(id) && items.length < pendingMax) items.push(row)
    } else if (d.state === 'kept') {
      kept.push({ row, rank: d.rank })
    }
  }
  kept.sort((a, b) => b.rank - a.rank)
  return { items, kept: kept.slice(0, keptMax).map((k) => k.row) }
}

module.exports = {
  decisionId,
  normalizeDecisions,
  applyDecision,
  mergeDecisions,
  sameDecisions,
  readRefs,
  splitRows
}
