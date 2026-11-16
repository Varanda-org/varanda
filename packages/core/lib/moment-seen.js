'use strict'

// The momentos the member has seen. The list syncs between the member's
// devices inside the encrypted seen document (lib/seen-blob.js), so a momento
// seen on one device shows as seen on every other. It writes no record and
// tells nobody: momentos have no view counts.
// Pure: no I/O and no clock, and it never throws on stored data.
//
// Entries are { author, seq, t }, one per momento (id author:seq), t in unix
// seconds, the time it was seen. Per id the newer time wins.

const { MOMENT_SEEN_MAX } = require('@varanda/rpc')

const HEX64 = /^[0-9a-f]{64}$/
const U32_MAX = 4294967295

function isSeq (n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= U32_MAX
}

function isRef (v) {
  return v !== null && typeof v === 'object' && typeof v.author === 'string' && HEX64.test(v.author) && isSeq(v.seq)
}

function validEntry (e) {
  return isRef(e) && Number.isSafeInteger(e.t) && e.t >= 0 && e.t <= U32_MAX
}

function momentId (author, seq) {
  return author + ':' + seq
}

function oldestFirst (a, b) {
  return a.t - b.t || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq
}

// Canonical form: valid entries only, one per id with its newest time, oldest
// first, cut to the newest MOMENT_SEEN_MAX.
function normalizeMomentSeen (list) {
  const byId = new Map()
  for (const e of Array.isArray(list) ? list : []) {
    if (!validEntry(e)) continue
    const id = momentId(e.author, e.seq)
    const held = byId.get(id)
    if (held === undefined || e.t > held.t) byId.set(id, { author: e.author, seq: e.seq, t: e.t })
  }
  const all = [...byId.values()].sort(oldestFirst)
  return all.length > MOMENT_SEEN_MAX ? all.slice(all.length - MOMENT_SEEN_MAX) : all
}

// -> { entries, changed }. A momento already in the list keeps its time, so
// marking it again changes nothing and wakes no sync. At a full list a clock
// running behind must not make the new mark the oldest entry, which the cap
// would cut at once.
function markMomentSeen (list, ref, nowSec) {
  const entries = normalizeMomentSeen(list)
  const unchanged = { entries, changed: false }
  try {
    if (!isRef(ref) || !Number.isSafeInteger(nowSec) || nowSec < 0) return unchanged
    const { author, seq } = ref
    if (entries.some((e) => e.author === author && e.seq === seq)) return unchanged
    let t = nowSec
    if (entries.length >= MOMENT_SEEN_MAX) t = Math.max(t, entries[0].t + 1)
    t = Math.min(t, U32_MAX)
    return { entries: normalizeMomentSeen([...entries, { author, seq, t }]), changed: true }
  } catch {
    return unchanged
  }
}

// Two devices' lists as one: commutative and idempotent, so devices that keep
// merging converge.
function mergeMomentSeen (a, b) {
  return normalizeMomentSeen([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])
}

// The refs 'author:seq', oldest first.
function momentSeenRefs (list) {
  return normalizeMomentSeen(list).map((e) => momentId(e.author, e.seq))
}

// The same momentos, whatever their times.
function sameMomentSeen (a, b) {
  const x = momentSeenRefs(a)
  const y = new Set(momentSeenRefs(b))
  return x.length === y.size && x.every((id) => y.has(id))
}

module.exports = { MOMENT_SEEN_MAX, normalizeMomentSeen, markMomentSeen, mergeMomentSeen, momentSeenRefs, sameMomentSeen }
