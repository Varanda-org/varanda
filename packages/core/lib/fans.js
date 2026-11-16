'use strict'

// Fas e Melhores amigos: the fold of one diary's `fan` and `top-friends`
// records (lib/records.js). Pure: no I/O, inputs are not mutated, every record
// is copied and validated once.
//
// A `fan` is a follow-shaped mark, independent of follow: the last operation
// per key wins (highest block), and an author holds at most
// MAX_FOLLOW_TARGETS_PER_AUTHOR distinct keys, like follows (lib/notices.js):
// a new key past the cap is refused, one already folded can still flip. The
// newest `top-friends` record wins and replaces the whole list. A fan of the
// author itself is dropped, and so is a top-friends record that names the
// author: it is as if it were never written, the earlier list stays. Whether a
// listed friend follows the owner back is evidence the caller reads elsewhere;
// the fold does not know it.

const { validRecordCopy, isHex64 } = require('./records')
const { applyDeletesOfCopies } = require('./deletion')
const { MAX_FOLLOW_TARGETS_PER_AUTHOR } = require('./notices')

// The live (not deleted) records of one diary as { seq, record } copies, in
// block order; entries that cannot be read or fail validation are skipped.
function liveEntries (entries) {
  if (!Array.isArray(entries)) return []
  const copies = []
  const seen = new Set()
  for (let i = 0; i < entries.length; i++) {
    try {
      const e = entries[i]
      if (e === null || typeof e !== 'object') continue
      const seq = e.seq
      if (!Number.isSafeInteger(seq) || seq < 1 || seen.has(seq)) continue
      seen.add(seq)
      copies.push({ seq, record: validRecordCopy(e.record, seq) })
    } catch {}
  }
  const out = []
  for (const { seq, record } of applyDeletesOfCopies(copies)) {
    if (record !== null && typeof record === 'object') out.push({ seq, record })
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}

// foldFans({ author, entries, max }) ->
//   { fans, top, truncated }
//   author     the diary's key (hex64)
//   entries    the diary's entries [{ seq, record }]
//   max        distinct fan keys kept (default MAX_FOLLOW_TARGETS_PER_AUTHOR)
//   fans       keys whose last operation is on, newest block first:
//              [{ key, seq, at }]
//   top        the newest live top-friends { seq, keys, at }, or null
//   truncated  true when a new key was refused at the cap
function foldFans ({ author, entries, max = MAX_FOLLOW_TARGETS_PER_AUTHOR } = {}) {
  if (!isHex64(author)) return { fans: [], top: null, truncated: false }
  const cap = Number.isSafeInteger(max) && max >= 0 ? max : MAX_FOLLOW_TARGETS_PER_AUTHOR
  const ops = new Map()
  let top = null
  let truncated = false
  for (const { seq, record } of liveEntries(entries)) {
    if (record.type === 'fan') {
      if (record.key === author) continue
      if (!ops.has(record.key) && ops.size >= cap) {
        truncated = true
        continue
      }
      ops.set(record.key, { seq, at: record.at, on: record.on })
    } else if (record.type === 'top-friends') {
      if (record.keys.includes(author)) continue
      top = { seq, keys: record.keys.slice(), at: record.at }
    }
  }
  const fans = []
  for (const [key, op] of ops) {
    if (op.on) fans.push({ key, seq: op.seq, at: op.at })
  }
  fans.sort((a, b) => b.seq - a.seq)
  return { fans, top, truncated }
}

module.exports = { foldFans }
