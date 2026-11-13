'use strict'

// Momentos: a `moment` record (lib/records.js) is shown by readers for
// MOMENT_TTL_MS after its `at`, then hidden; the record itself stays in the
// diary until its author deletes it. Pure: no I/O, inputs are not mutated,
// never reads the caller's records twice (each is copied and checked once).

const { validRecordCopy, isHex64, formatRef } = require('./records')
const { applyDeletesOfCopies } = require('./deletion')
const { liveLogCopies } = require('./feed')
const MOMENT_TTL_MS = 86400000
// A moment dated ahead of the reader's clock shows only within this skew:
// further ahead it waits for its time, so no date buys more than
// MOMENT_TTL_MS + MOMENT_SKEW_MS on screen (feed.js's MAX_FUTURE_MS, 24 h,
// would allow almost 48 h).
const MOMENT_SKEW_MS = 10 * 60 * 1000
const MAX_MOMENT_AUTHORS = 32
const MAX_MOMENTS_PER_AUTHOR = 4
const MAX_PAST_MOMENTS = 16

// The live (not deleted) moment records of one log, as { seq, t, record }
// copies. A log is { key, entries } as lib/feed.js folds; anything else,
// and any entry that cannot be read, is skipped.
// The live moments of a log. With `cut` ({ association, revokedIssuers })
// the log is folded exactly as the feed folds it (feed.js liveLogCopies: a
// verified page-close or page-moved ends it, then tombstones), so a closed or
// migrated page cannot keep showing moments; without it, tombstones only.
function liveMoments (entries, cut = null, key = null, raw) {
  if (!Array.isArray(entries)) return []
  const copies = []
  for (let i = 0; i < entries.length; i++) {
    try {
      const e = entries[i]
      if (e === null || typeof e !== 'object') continue
      const seq = e.seq
      if (!Number.isSafeInteger(seq) || seq < 1) continue
      copies.push(cut === null ? { seq, record: validRecordCopy(e.record, seq) } : { seq, record: e.record })
    } catch {}
  }
  let live
  if (cut === null) {
    live = applyDeletesOfCopies(copies)
  } else {
    try {
      live = liveLogCopies({ key, entries: copies, raw: Array.isArray(raw) ? raw : undefined }, cut)
    } catch {
      return []
    }
  }
  const out = []
  for (const { seq, record } of live) {
    if (record === null || record.type !== 'moment') continue
    out.push({ seq, t: Date.parse(record.at), record })
  }
  return out
}

function cutOf (association, revokedIssuers) {
  return typeof association === 'string' && isHex64(association) ? { association, revokedIssuers: revokedIssuers || null } : null
}

function newestFirst (a, b) {
  return (b.t - a.t) || (b.seq - a.seq)
}

function readLog (log) {
  try {
    if (log === null || typeof log !== 'object') return null
    const key = log.key
    if (!isHex64(key)) return null
    return { key, entries: log.entries, raw: log.raw }
  } catch {
    return null
  }
}

function checkNow (now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('now inválido')
}

// The showing moments of every log: per author newest first, at most
// MAX_MOMENTS_PER_AUTHOR; authors by their newest moment, at most
// MAX_MOMENT_AUTHORS. A moment dated more than MOMENT_SKEW_MS ahead is hidden
// until its time comes (a forward date must not stretch the 24 h), and one is gone once
// at + MOMENT_TTL_MS <= now. A key repeated in `logs` counts once (the first).
function foldMoments ({ logs, now = Date.now(), association = null, revokedIssuers = null } = {}) {
  checkNow(now)
  const cut = cutOf(association, revokedIssuers)
  const authors = []
  const seen = new Set()
  if (Array.isArray(logs)) {
    for (let i = 0; i < logs.length; i++) {
      let log
      try { log = readLog(logs[i]) } catch { log = null }
      if (log === null || seen.has(log.key)) continue
      seen.add(log.key)
      const showing = liveMoments(log.entries, cut, log.key, log.raw)
        .filter(({ t }) => t - now <= MOMENT_SKEW_MS && t + MOMENT_TTL_MS > now)
        .sort(newestFirst)
        .slice(0, MAX_MOMENTS_PER_AUTHOR)
      if (showing.length === 0) continue
      authors.push({
        key: log.key,
        t: showing[0].t,
        items: showing.map(({ seq, record }) => ({
          seq,
          ref: formatRef({ author: log.key, seq }),
          text: record.text,
          at: record.at,
          media: { ...record.media },
          music: record.music ? { ...record.music } : null
        }))
      })
    }
  }
  authors.sort((a, b) => (b.t - a.t) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return {
    authors: authors.slice(0, MAX_MOMENT_AUTHORS).map(({ key, items }) => ({ author: key, items }))
  }
}

// The media item of moment `seq` of `log` while it is live and showing (the
// same time rules as foldMoments, without its list caps: an older moment
// still in its 24 h keeps its photo when newer ones fill the list), else null.
function showingMoment (log, seq, now = Date.now(), { association = null, revokedIssuers = null } = {}) {
  checkNow(now)
  const one = readLog(log)
  if (one === null || !Number.isSafeInteger(seq) || seq < 1) return null
  const hit = liveMoments(one.entries, cutOf(association, revokedIssuers), one.key, one.raw).find((m) => m.seq === seq)
  if (hit === undefined || !(hit.t - now <= MOMENT_SKEW_MS && hit.t + MOMENT_TTL_MS > now)) return null
  return { ...hit.record.media }
}

// The own expired, live moments, newest first, at most MAX_PAST_MOMENTS, so
// the author can still delete them. `log` is { key, entries }.
function ownPast (log, now = Date.now()) {
  checkNow(now)
  const own = readLog(log)
  if (own === null) return []
  return liveMoments(own.entries)
    .filter(({ t }) => t + MOMENT_TTL_MS <= now)
    .sort(newestFirst)
    .slice(0, MAX_PAST_MOMENTS)
    .map(({ seq, record }) => ({ seq, ref: formatRef({ author: own.key, seq }), text: record.text, at: record.at }))
}

module.exports = {
  MOMENT_TTL_MS,
  MOMENT_SKEW_MS,
  MAX_MOMENT_AUTHORS,
  MAX_MOMENTS_PER_AUTHOR,
  MAX_PAST_MOMENTS,
  foldMoments,
  ownPast,
  showingMoment
}
