'use strict'

// Engagement state of one diary: its `like` and `repost` records replayed in
// seq order, the last operation per (type, target ref) wins (the same rule as
// followSet in lib/media.js). Liking or reposting an own post is allowed and
// counted. Pure and total: invalid entries are skipped, nothing ever throws.

const { validRecordCopy, formatRef } = require('./records')

// `entries`: [{ seq, record }]. Returns { liked: Set<ref>, reposted:
// Map<ref, { seq, at }> } where seq/at are those of the effective `on` record.
function engagementState (entries) {
  return replay(entries, validRecordCopy)
}

// engagementState over entries whose records are already validRecordCopy
// output for that same entry's seq (or null), as lib/feed.js makes once per
// call. Never pass a caller's records: they would not be copied or checked.
function engagementOfCopies (copies) {
  return replay(copies, (record) => record)
}

function replay (entries, copyOf) {
  const liked = new Set()
  const reposted = new Map()
  try {
    if (!Array.isArray(entries)) return { liked, reposted }
    const list = []
    for (let i = 0; i < entries.length; i++) {
      try {
        const entry = entries[i]
        if (entry === null || typeof entry !== 'object') continue
        const seq = entry.seq
        if (!Number.isSafeInteger(seq) || seq < 1) continue
        const copy = copyOf(entry.record, seq)
        if (copy !== null && (copy.type === 'like' || copy.type === 'repost')) list.push({ seq, record: copy })
      } catch {}
    }
    list.sort((a, b) => a.seq - b.seq)
    for (const { seq, record } of list) {
      const ref = formatRef(record.to)
      if (record.type === 'like') {
        if (record.on) liked.add(ref)
        else liked.delete(ref)
      } else if (record.on) {
        // Map order follows insertion: re-insert so the latest `on` is last.
        reposted.delete(ref)
        reposted.set(ref, { seq, at: record.at })
      } else {
        reposted.delete(ref)
      }
    }
  } catch {
    return { liked: new Set(), reposted: new Map() }
  }
  return { liked, reposted }
}

function isLiked (state, ref) {
  try {
    return state !== null && typeof state === 'object' && state.liked instanceof Set && state.liked.has(ref)
  } catch {
    return false
  }
}

function isReposted (state, ref) {
  try {
    return state !== null && typeof state === 'object' && state.reposted instanceof Map && state.reposted.has(ref)
  } catch {
    return false
  }
}

module.exports = { engagementState, engagementOfCopies, isLiked, isReposted }
