'use strict'

// Recados: the fold of one page's wall over verified diary entries (the
// `scrap`, `scrap-hide` and `scrap-wall` records of lib/records.js). Pure: no
// I/O, inputs are not mutated, every record is copied and validated once.
//
// The owner's diary carries the wall policy (`scrap-wall`, latest live one
// wins, 'following' when none), the hides (`scrap-hide`) and the scraps the
// owner left elsewhere (the originals a reply answers). Each writer's diary
// carries the scraps addressed to the owner. Whether the owner follows a
// writer is evidence the caller read (the owner's follow pointer); the fold
// only consults it.

const { validRecordCopy, isHex64, formatRef } = require('./records')
const { applyDeletesOfCopies } = require('./deletion')
const { MAX_FUTURE_MS } = require('./feed')

const DEFAULT_WALL = 'following'

// The live (not deleted) records of one diary as { seq, record } copies;
// entries that cannot be read or fail validation are skipped.
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
  // Block order, whatever order the caller listed the entries in.
  out.sort((a, b) => a.seq - b.seq)
  return out
}

function readDiary (diary) {
  try {
    if (diary === null || typeof diary !== 'object') return null
    const key = diary.key
    if (!isHex64(key)) return null
    return { key, entries: diary.entries }
  } catch {
    return null
  }
}

// Does the owner follow this writer? `follows` is a Map or a plain object of
// writer key -> true, or the positive seq of the owner's live follow record.
function followsWriter (follows, writer) {
  try {
    let v
    if (follows instanceof Map) v = follows.get(writer)
    else if (follows !== null && typeof follows === 'object' && Object.prototype.hasOwnProperty.call(follows, writer)) v = follows[writer]
    return v === true || (Number.isSafeInteger(v) && v >= 1)
  } catch {
    return false
  }
}

// The policy the owner's diary sets: the live scrap-wall with the highest
// block wins; none means 'following'.
function wallOf (ownerLive) {
  let best = null
  for (const { seq, record } of ownerLive) {
    if (record.type === 'scrap-wall' && (best === null || seq > best.seq)) best = { seq, who: record.who }
  }
  return best === null ? DEFAULT_WALL : best.who
}

// Newest first by `at`, then author, then seq (author ascending, seq
// descending: of two scraps with the same instant the later block is newer).
function order (a, b) {
  if (a.t !== b.t) return b.t - a.t
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return b.seq - a.seq
}

// foldWall({ owner, ownerEntries, writers, follows, now }) -> { wall, scraps }
//   owner         the page owner's key (hex64)
//   ownerEntries  the owner's diary entries [{ seq, record }]
//   writers       candidate writers' diaries [{ key, entries }]
//   follows       evidence: writer -> true | owner's follow seq (Map or object)
//   now           the reader's clock in ms (default Date.now()): a scrap dated
//                 more than MAX_FUTURE_MS ahead of it is not shown
// `scraps` is [{ author, seq, ref, text, at, replyTo, via }] where `via` is
// why it is admitted: 'everyone', 'following' or 'reply'. A scrap of the
// owner's own diary, a scrap not addressed to the owner and a hidden one are
// never shown; 'nobody' shows nothing; under 'following' an unfollowed
// writer's scrap is shown only as the one reply to a live scrap the owner
// left on that writer's page (replyTo names it) and answering it, so dated
// no earlier than it. The first such reply (lowest block) takes the slot of
// its original even when the owner hides it; only the writer's own delete
// frees the slot.
function foldWall ({ owner, ownerEntries, writers, follows, now = Date.now() } = {}) {
  if (typeof owner !== 'string' || !isHex64(owner)) return { wall: DEFAULT_WALL, scraps: [] }
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const ownerLive = liveEntries(ownerEntries)
  const wall = wallOf(ownerLive)
  if (wall === 'nobody') return { wall, scraps: [] }

  const hidden = new Set()
  // Live scraps of the owner's diary by seq -> { to, t }: the page they were
  // left on and their date.
  const originals = new Map()
  for (const { seq, record } of ownerLive) {
    if (record.type === 'scrap-hide') hidden.add(formatRef({ author: record.from, seq: record.seq }))
    else if (record.type === 'scrap') originals.set(seq, { to: record.to, t: Date.parse(record.at) })
  }

  const out = []
  const doneWriters = new Set([owner])
  const list = Array.isArray(writers) ? writers : []
  for (let i = 0; i < list.length; i++) {
    const diary = readDiary(list[i])
    if (diary === null || doneWriters.has(diary.key)) continue
    doneWriters.add(diary.key)
    const author = diary.key
    const followed = wall !== 'everyone' && followsWriter(follows, author)
    // The first live reply (lowest block) to each of the owner's scraps.
    const replied = new Set()
    for (const { seq, record } of liveEntries(diary.entries)) {
      if (record.type !== 'scrap' || record.to !== owner) continue
      const ref = formatRef({ author, seq })
      const t = Date.parse(record.at)
      if (t - clock > MAX_FUTURE_MS) continue
      let answers = false
      if (wall === 'following') {
        const rt = record.replyTo
        const original = rt !== null && rt.author === owner ? originals.get(rt.seq) : undefined
        if (original !== undefined && original.to === author && t >= original.t && !replied.has(rt.seq)) {
          answers = true
          replied.add(rt.seq)
        }
      }
      if (hidden.has(ref)) continue
      let via = null
      if (wall === 'everyone') via = 'everyone'
      else if (followed) via = 'following'
      else if (answers) via = 'reply'
      if (via === null) continue
      out.push({
        author,
        seq,
        ref,
        text: record.text,
        at: record.at,
        replyTo: record.replyTo === null ? null : { author: record.replyTo.author, seq: record.replyTo.seq },
        via,
        t
      })
    }
  }
  out.sort(order)
  return { wall, scraps: out.map(({ t, ...rest }) => rest) }
}

module.exports = {
  DEFAULT_WALL,
  foldWall,
  wallOf
}
