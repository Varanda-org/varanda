'use strict'

// Deletion fold over one diary's entries ({ seq, record }). A `delete`
// record (lib/records.js) at block b removes block `seq` whatever that
// block is and whether or not this replica holds it. Walking from the
// highest block down, a tombstone takes effect only if no later effective
// tombstone deleted it, so the result is the same on every replica that
// holds the same blocks. Pure: no I/O, never throws (also loaded by the
// browser node).

const { validRecordCopy } = require('./records')

// Always a fresh copy: reading entries can run getters, which must not be
// able to change a caller's set while the fold consults it.
function toSet (v) {
  if (v instanceof Set) return new Set(v)
  return new Set(Array.isArray(v) ? v : [])
}

// Valid tombstones, highest block first, one per block.
function tombstones (entries) {
  const out = []
  if (!Array.isArray(entries)) return out
  const seen = new Set()
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || seen.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null || copy.type !== 'delete') continue
      seen.add(seq)
      out.push({ seq, record: copy })
    } catch {}
  }
  return out.sort((a, b) => b.seq - a.seq)
}

function fold (entries) {
  const deleted = new Set()
  const effective = []
  for (const t of tombstones(entries)) {
    if (deleted.has(t.seq)) continue
    deleted.add(t.record.seq)
    effective.push(t)
  }
  return { deleted, effective }
}

function deletedSeqs (entries) {
  return fold(entries).deleted
}

// Same length and order as entries, so slicing by index is unchanged.
function applyDeletes (entries) {
  if (!Array.isArray(entries)) return []
  const { deleted } = fold(entries)
  const out = new Array(entries.length)
  for (let i = 0; i < entries.length; i++) {
    let entry
    let seq
    try {
      entry = entries[i]
      seq = entry !== null && typeof entry === 'object' ? entry.seq : undefined
    } catch {}
    out[i] = Number.isSafeInteger(seq) && deleted.has(seq) ? { seq, record: null, deleted: true } : entry
  }
  return out
}

// A range that a surviving post or profile still overlaps is never returned:
// writers never emit one, and a hand-made tombstone must not erase bytes a
// live record shows.
function deletedRanges (entries, cores) {
  const allowed = toSet(cores)
  const live = liveMediaRefs(entries)
  const out = []
  for (const { record } of fold(entries).effective) {
    if (!Array.isArray(record.media)) continue
    for (const r of record.media) {
      if (!allowed.has(r.core) || live.some((l) => overlaps(l, r))) continue
      out.push({ core: r.core, start: r.start, blocks: r.blocks })
    }
  }
  return out
}

// Media still referenced by a surviving post or profile, other than the
// blocks in exceptSeqs.
function liveMediaRefs (entries, exceptSeqs) {
  const except = toSet(exceptSeqs)
  const out = []
  if (!Array.isArray(entries)) return out
  const { deleted } = fold(entries)
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || deleted.has(seq) || except.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null) continue
      let descriptors = []
      if (copy.type === 'post' && Array.isArray(copy.media)) descriptors = copy.media
      else if (copy.type === 'profile' && copy.avatar !== undefined) descriptors = [copy.avatar]
      for (const d of descriptors) out.push({ core: d.core, start: d.start, blocks: d.blocks })
    } catch {}
  }
  return out
}

function overlaps (a, b) {
  try {
    return a.core === b.core && a.start < b.start + b.blocks && b.start < a.start + a.blocks
  } catch {
    return false
  }
}

module.exports = {
  deletedSeqs,
  applyDeletes,
  deletedRanges,
  liveMediaRefs,
  overlaps
}
