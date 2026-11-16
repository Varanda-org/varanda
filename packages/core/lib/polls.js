'use strict'

// Enquetes: the pure fold of poll votes (docs/protocol.md). Pure: no I/O,
// inputs are not mutated, every record is copied and validated once, nothing
// ever throws.
//
// A diary poll is a post with a `poll` key (lib/records.js); a vote is a
// `choice` record in the voter's own diary naming that post. Per voter and
// poll the last live choice wins (highest block): a pick replaces the earlier
// one, a null pick withdraws it, and a pick outside the poll's options is
// ignored, as if it were never written (the earlier pick stays). A deleted
// choice is no choice. Voting on an own poll counts. A choice dated more
// than MAX_FUTURE_MS after `now` is not written yet: it counts from its date,
// as a group vote does (lib/group.js isFuture). Group polls fold the same way
// from their `group-choice` side records (foldPicks).

const { validRecordCopy, isHex64, POLL_MAX } = require('./records')
const { applyDeletesOfCopies } = require('./deletion')

// Same value as lib/feed.js and lib/group.js MAX_FUTURE_MS (not imported:
// this module stays small for the browser node).
const MAX_FUTURE_MS = 86400000

function isCount (count) {
  return Number.isSafeInteger(count) && count >= 1 && count <= POLL_MAX
}

function inRange (pick, count) {
  return pick === null || (Number.isSafeInteger(pick) && pick >= 0 && pick < count)
}

function clock (now) {
  return Number.isFinite(now) ? now : Date.now()
}

function isFuture (at, now) {
  return Date.parse(at) - now > MAX_FUTURE_MS
}

function sameTarget (to, poll) {
  return to.author === poll.author && to.seq === poll.seq
}

// The options of a poll post record, a fresh array, or null when the record
// is not a valid poll post.
function pollOptions (record, seq = 1) {
  try {
    const copy = validRecordCopy(record, Number.isSafeInteger(seq) && seq >= 1 ? seq : 1)
    return copy !== null && copy.type === 'post' && Array.isArray(copy.poll) ? copy.poll.slice() : null
  } catch {
    return null
  }
}

// foldPicks(ops, count) -> { totals, picks }
//   ops     [{ voter, pick }] in causal order (later wins), voter a hex64 key
//   count   the poll's number of options
//   totals  votes per option, an array of `count` integers
//   picks   Map voter -> live pick (voters with no live pick are absent)
function foldPicks (ops, count) {
  const picks = new Map()
  if (!isCount(count)) return { totals: [], picks }
  try {
    if (Array.isArray(ops)) {
      for (let i = 0; i < ops.length; i++) {
        try {
          const op = ops[i]
          if (op === null || typeof op !== 'object') continue
          const { voter, pick } = op
          if (!isHex64(voter) || !inRange(pick, count)) continue
          if (pick === null) picks.delete(voter)
          else picks.set(voter, pick)
        } catch {}
      }
    }
  } catch {}
  const totals = new Array(count).fill(0)
  for (const pick of picks.values()) totals[pick]++
  return { totals, picks }
}

// livePick({ entries, poll, count, now }) -> { pick, seq, at } | null
//   entries  one voter diary's entries [{ seq, record }]
//   poll     the poll post { author, seq }
//   count    the poll's number of options
//   now      ms clock (default Date.now()); later-dated choices are skipped
// The voter's live pick on that poll, with the seq and at of the choice
// record that set it; null when there is none (never voted, withdrawn, or
// every choice deleted, out of range or dated ahead).
function livePick ({ entries, poll, count, now } = {}) {
  try {
    if (!isCount(count) || poll === null || typeof poll !== 'object') return null
    now = clock(now)
    const target = { author: poll.author, seq: poll.seq }
    if (!isHex64(target.author) || !Number.isSafeInteger(target.seq) || target.seq < 1) return null
    let live = null
    for (const { seq, record } of liveEntries(entries)) {
      if (record.type !== 'choice' || !sameTarget(record.to, target) || !inRange(record.pick, count) || isFuture(record.at, now)) continue
      live = record.pick === null ? null : { pick: record.pick, seq, at: record.at }
    }
    return live
  } catch {
    return null
  }
}

// tallyPoll({ poll, count, voters, now }) -> { totals, picks }
//   voters  [{ voter, entries }], each voter's own diary entries; a voter
//           listed twice counts once (the first listing)
//   now     as in livePick
// The totals and live picks of one diary poll over the given diaries.
function tallyPoll ({ poll, count, voters, now } = {}) {
  const ops = []
  const seen = new Set()
  try {
    now = clock(now)
    if (Array.isArray(voters)) {
      for (let i = 0; i < voters.length; i++) {
        try {
          const v = voters[i]
          if (v === null || typeof v !== 'object' || !isHex64(v.voter) || seen.has(v.voter)) continue
          seen.add(v.voter)
          const live = livePick({ entries: v.entries, poll, count, now })
          if (live !== null) ops.push({ voter: v.voter, pick: live.pick })
        } catch {}
      }
    }
  } catch {}
  return foldPicks(ops, count)
}

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

module.exports = { pollOptions, foldPicks, livePick, tallyPoll, MAX_FUTURE_MS }
