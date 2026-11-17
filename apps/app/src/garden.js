// Varandinha: the pure model of one balcony. It plans which blocks to peek,
// judges each peeked block and hands the verdict to the contract fold
// (rpc.garden.foldBalcony), so a forged pointer from the seeder never counts.
// A stale but authentic block is the residual docs/protocol.md names for the
// Varandinha index. It also keeps the pending acts of one play session and the consent
// sheet. No React, no platform module, no request: the caller does the reads
// this model plans. Nothing here throws on hostile input.

import rpc from '@varanda/rpc'
import { peekBatches } from './fans.js'

const HEX64 = /^[0-9a-f]{64}$/

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isHint = (v) => v === null || isSeq(v)

function blockedBy (isBlocked) {
  return (key) => {
    if (typeof isBlocked !== 'function') return false
    try {
      return isBlocked(key) === true
    } catch {
      return true
    }
  }
}

function readIndex (index) {
  try {
    if (!isObject(index) || !isHint(index.on) || !isHint(index.state)) return null
    if (!Array.isArray(index.helps) || !Array.isArray(index.given)) return null
    // The caps of the index route: a longer list never fans out into peeks.
    if (index.helps.length > rpc.garden.GARDEN_HELP_ROWS || index.given.length > rpc.garden.GARDEN_HELP_ROWS) return null
    const helps = []
    const seen = new Set()
    for (const row of index.helps) {
      if (!isObject(row) || !isHex64(row.author) || !isSeq(row.seq) || !isSeq(row.followSeq)) return null
      const ref = row.author + ':' + row.seq
      if (seen.has(ref)) continue
      seen.add(ref)
      helps.push({ author: row.author, seq: row.seq, followSeq: row.followSeq })
    }
    const given = new Set()
    for (const s of index.given) {
      if (!isSeq(s)) return null
      given.add(s)
    }
    return { on: index.on, state: index.state, helps, given: [...given], indexing: index.indexing === true, complete: index.complete === true }
  } catch {
    return null
  }
}

export function planPeeks (args) {
  const { owner, index, isBlocked } = isObject(args) ? args : {}
  if (!isHex64(owner)) return { owner: [], helpers: [] }
  const idx = readIndex(index)
  if (idx === null) return { owner: peekBatches(owner, [1, 2]), helpers: [] }
  const blocked = blockedBy(isBlocked)
  // One entry per author: the index keeps one row per helper per day, so an
  // author can have several rows. helperReads.get(author) holds that author's
  // peek answer, or an array of answers when there are several batches
  // (readsOf accepts both).
  const byAuthor = new Map()
  for (const row of idx.helps) {
    if (row.author === owner || blocked(row.author)) continue
    let entry = byAuthor.get(row.author)
    if (!entry) {
      entry = { seqs: new Set(), rows: [] }
      byAuthor.set(row.author, entry)
    }
    entry.seqs.add(row.seq)
    entry.seqs.add(row.followSeq)
    entry.rows.push(row)
  }
  const helpers = []
  for (const [author, entry] of byAuthor) {
    helpers.push({ author, batches: peekBatches(author, [...entry.seqs].sort((a, b) => a - b)), rows: entry.rows })
  }
  const ownerSeqs = [1, 2, idx.on, idx.state, ...idx.given].filter((s) => s !== null)
  return { owner: peekBatches(owner, ownerSeqs), helpers }
}

// The records of one author's diary.peek answer(s) by seq. A seq the node
// named invalid or missing is unread, whatever else the answer holds.
function readsOf (key, peeks) {
  const live = new Map()
  const unread = new Set()
  const list = Array.isArray(peeks) ? peeks : [peeks]
  for (const p of list) {
    if (!isObject(p) || p.key !== key) continue
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (isObject(e) && isSeq(e.seq) && isObject(e.record) && !live.has(e.seq)) live.set(e.seq, e.record)
    }
    for (const s of Array.isArray(p.invalid) ? p.invalid : []) if (isSeq(s)) unread.add(s)
    for (const s of Array.isArray(p.missing) ? p.missing : []) if (isSeq(s)) unread.add(s)
  }
  for (const s of unread) live.delete(s)
  return { live, unread }
}

const typeIs = (record, type) => isObject(record) && record.type === type

function emptyBalcony () {
  return {
    on: false,
    pots: new Array(rpc.garden.GARDEN_POTS).fill(null),
    helpers: [],
    isPage: false,
    stale: false,
    loading: false,
    incomplete: true,
    indexing: false,
    refetch: false
  }
}

export function assembleBalcony (args) {
  try {
    const { owner, index, ownerReads, helperReads, now, isBlocked } = isObject(args) ? args : {}
    const out = emptyBalcony()
    if (!isHex64(owner) || !Number.isFinite(now)) return out
    const idx = readIndex(index)
    const own = readsOf(owner, ownerReads)
    if (typeIs(own.live.get(1), 'page-roster') || typeIs(own.live.get(2), 'page-roster')) {
      out.isPage = true
      out.incomplete = false
      return out
    }
    // As the node's own check: a page's roster may hide in an unread block 1
    // or 2, so nothing is folded until both were read.
    if (own.unread.has(1) || own.unread.has(2)) return out
    if (idx === null) return out
    out.indexing = idx.indexing
    let incomplete = idx.complete !== true
    let refetch = false
    const pointer = (seq, type) => {
      if (seq === null) return null
      const record = own.live.get(seq)
      if (typeIs(record, type)) return record
      refetch = true
      return null
    }
    const flag = pointer(idx.on, 'garden')
    const state = pointer(idx.state, 'garden-state')
    const given = []
    for (const seq of idx.given) {
      const record = own.live.get(seq)
      if (typeIs(record, 'garden-help')) given.push({ seq, record })
      else incomplete = true
    }
    const blocked = blockedBy(isBlocked)
    const helps = []
    let loading = false
    for (const row of idx.helps) {
      if (row.author === owner || blocked(row.author)) continue
      const raw = helperReads instanceof Map ? helperReads.get(row.author) : undefined
      if (raw === undefined || raw === null) {
        loading = true
        continue
      }
      const read = readsOf(row.author, raw)
      const record = read.live.get(row.seq)
      const follow = read.live.get(row.followSeq)
      if (record === undefined || follow === undefined) incomplete = true
      helps.push({ author: row.author, seq: row.seq, record, follow })
    }
    const folded = rpc.garden.foldBalcony({ owner, flag, state, helps, given, now })
    return { on: folded.on, pots: folded.pots, helpers: folded.helpers, isPage: false, stale: folded.stale, loading, incomplete, indexing: idx.indexing, refetch }
  } catch {
    return emptyBalcony()
  }
}

export function nextLoadStep (args) {
  const { attempt, result } = isObject(args) ? args : {}
  if (!isObject(result) || result.refetch !== true) return 'done'
  return attempt === 0 ? 'refetch' : 'incomplete'
}

export function flagOn (entries, seq) {
  try {
    if (!isSeq(seq) || !Array.isArray(entries)) return false
    for (const e of entries) {
      if (isObject(e) && e.seq === seq) return isObject(e.record) && e.record.type === 'garden' && e.record.on === true
    }
    return false
  } catch {
    return false
  }
}

const sixNulls = () => new Array(rpc.garden.GARDEN_POTS).fill(null)

export function pendingStart (pots) {
  const base = Array.isArray(pots) && pots.length === rpc.garden.GARDEN_POTS ? pots : sixNulls()
  return { base, acts: [], pots: base, refused: null }
}

function judge (p, acts, now, counts) {
  if (acts.length === 0) return { ok: true, state: { pots: p.base } }
  return rpc.garden.applyActs({ pots: p.base }, acts, now, counts)
}

export function queue (p, act, now, counts) {
  try {
    const acts = [...p.acts, act]
    const r = judge(p, acts, now, counts)
    if (!r.ok) return { ...p, refused: r.reason }
    return { base: p.base, acts, pots: r.state.pots, refused: null }
  } catch {
    return { ...p, refused: 'invalid' }
  }
}

export function revalidate (p, now, counts) {
  try {
    const r = judge(p, p.acts, now, counts)
    if (!r.ok) {
      let n = p.acts.length - 1
      let kept = null
      while (n >= 0 && kept === null) {
        const k = judge(p, p.acts.slice(0, n), now, counts)
        if (k.ok) kept = { acts: p.acts.slice(0, n), pots: k.state.pots }
        else n--
      }
      if (kept === null) kept = { acts: [], pots: p.base }
      return { base: p.base, ...kept, refused: r.reason }
    }
    return { ...p, pots: r.state.pots, refused: null }
  } catch {
    return { ...p, refused: 'invalid' }
  }
}

export function pendingCount (p) {
  return isObject(p) && Array.isArray(p.acts) ? p.acts.length : 0
}

export function discard (p) {
  return pendingStart(isObject(p) ? p.base : null)
}

export function initialConsent () {
  return { open: false, visible: false, busy: false }
}
export function openConsent () {
  return { open: true, visible: false, busy: false }
}
export function toggleConsent (state) {
  return state.busy ? state : { ...state, visible: !state.visible }
}
export function startConsent (state) {
  return state.visible && !state.busy ? { ...state, busy: true } : state
}
export function closeConsent () {
  return initialConsent()
}
