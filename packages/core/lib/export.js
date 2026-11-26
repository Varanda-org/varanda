'use strict'

// Pure paging helpers behind export.read (docs/rpc.md 5.180). The session
// and the browser node feed them raw member.logRead output (tombstones not
// applied) and the stored lists; nothing here touches storage. Tombstones
// are applied over the blocks below the snapshot bound only, so a delete
// written after the head never blanks a block the export already counted.

const { validRecordCopy, validateRecord, latestProfile } = require('./records')
const { applyDeletes, deletedSeqs } = require('./deletion')
const { EXPORT_PAGE_MAX, EXPORT_PAGE_BYTES, FOLLOW_LIMIT_MAX, utf8ByteLength, followsDigest } = require('@varanda/rpc')

// The prefix read (holes a tombstone cleared kept as null records) wins over
// readHeld's copy of the same seq; readHeld adds the blocks past other holes.
function mergeHeld (prefix, held) {
  const bySeq = new Map(held.map((e) => [e.seq, e]))
  for (const e of prefix) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function snapshot (entries, until) {
  return applyDeletes(entries.filter((e) => e.seq < until))
}

// length: the diary's signed length, not the readable prefix, so blocks this
// device does not hold show up as missing seqs instead of vanishing.
function exportHead ({ association, length, entries, follows, blocked, muted }) {
  const followCount = follows.length
  const p = latestProfile(snapshot(entries, length))
  const head = {
    format: 'varanda-export',
    version: 1,
    association,
    length,
    follows: followCount,
    followsDigest: followsDigest(follows),
    profile: p === null ? null : { name: p.name, bio: p.bio },
    blocked: Array.isArray(blocked) ? blocked : null,
    muted: Array.isArray(muted) ? muted : null
  }
  let next = null
  if (followCount > 0) next = { part: 'follows', offset: 0, until: length }
  else if (length > 0) next = { part: 'diary', offset: 0, until: length }
  return { head, next }
}

function exportFollowsPage (follows, offset, until) {
  const page = follows.slice(offset, offset + FOLLOW_LIMIT_MAX)
  const end = offset + page.length
  let next = null
  if (end < follows.length) next = { part: 'follows', offset: end, until }
  else if (until > 0) next = { part: 'diary', offset: 0, until }
  return { follows: page, next }
}

function exportDiaryPage (entries, offset, until, { maxBlocks = EXPORT_PAGE_MAX, maxBytes = EXPORT_PAGE_BYTES } = {}) {
  const out = []
  const invalid = []
  let bytes = 0
  let count = 0
  let last = -1
  let more = false
  // A delete written after the head may already have cleared its target's
  // bytes: that hole is still a deletion, not a malformed block.
  const erased = deletedSeqs(entries)
  for (const { seq, record, deleted } of snapshot(entries, until)) {
    if (seq < offset) continue
    let item
    let ok = false
    if (record === null) {
      item = { seq, reason: deleted === true || erased.has(seq) ? 'deleted' : 'malformed' }
    } else {
      const copy = validRecordCopy(record, seq)
      if (copy !== null) {
        item = { seq, record: copy }
        ok = true
      } else {
        item = { seq, reason: validateRecord(record, seq) || 'malformed' }
      }
    }
    const cost = utf8ByteLength(JSON.stringify(item)) + 1
    if (count > 0 && (count >= maxBlocks || bytes + cost > maxBytes)) {
      more = true
      break
    }
    bytes += cost
    count++
    last = seq
    if (ok) out.push(item)
    else invalid.push(item)
  }
  return { entries: out, invalid, next: more ? { part: 'diary', offset: last + 1, until } : null }
}

module.exports = { exportHead, exportFollowsPage, exportDiaryPage, mergeHeld }
