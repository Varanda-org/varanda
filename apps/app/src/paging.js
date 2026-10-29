// Pure backward paging helpers. Feed arrays arrive oldest first; screen
// arrays stay newest first, without mutating pages or repeating identities.

export function feedKey (item) {
  return item.author + ':' + item.seq
}

export function cursorOf (pageAscending) {
  if (pageAscending.length === 0) return null
  const { at, author, seq } = pageAscending[0]
  return { at, author, seq }
}

export function toNewestFirst (pageAscending) {
  return pageAscending.slice().reverse()
}

// A reset returns the new screen array, with the same deduplication as a merge.
export function resetWith (pageAscending) {
  return mergeOlder([], pageAscending).items
}

export function mergeOlder (currentNewestFirst, pageAscending) {
  const seen = new Set()
  const items = []
  const append = (item) => {
    const key = feedKey(item)
    if (seen.has(key)) return
    seen.add(key)
    items.push(item)
  }
  for (const item of currentNewestFirst) append(item)
  const before = items.length
  for (const item of toNewestFirst(pageAscending)) append(item)
  return { items, added: items.length - before }
}

// This takes the feed.read response, unlike the array transforms above.
export function isLastFeedPage (page, limit) {
  return page.items.length < limit
}

export function cursorMoved (prev, next) {
  return next !== null && (prev === null || next.at !== prev.at || next.author !== prev.author || next.seq !== prev.seq)
}

export function logRows (log) {
  return log.entries.map((entry) => ({ seq: entry.seq, entry }))
    .concat(log.invalid.map((invalid) => ({ seq: invalid.seq, invalid })))
    .sort((a, b) => b.seq - a.seq)
}

export function mergeOlderRows (rows, log) {
  const seen = new Set()
  return rows.concat(logRows(log)).filter((row) => {
    if (seen.has(row.seq)) return false
    seen.add(row.seq)
    return true
  }).sort((a, b) => b.seq - a.seq)
}

export function oldestSeq (rows) {
  return rows.length === 0 ? null : rows[rows.length - 1].seq
}

export function isLastLogPage (log) {
  return log.entriesTruncated === 0
}

export function shouldReloadOnShow ({ loadedAt, now, fresh, maxAgeMs = 60000 }) {
  return loadedAt === null || fresh === true || now - loadedAt >= maxAgeMs
}

export const FEED_SYNCING_END = 'Ainda sincronizando quem você segue.'

// Every feed.read preempts the sync run, which restarts after it (docs/rpc.md
// section 6.1), so automatic reads are spaced by at least this window.
export const FEED_REARM_MS = 2000
export const FEED_REARM_MAX_STEPS = 4

// A diary downloaded in order grows with newer blocks, so after an empty
// before read its next arrivals usually sort inside the range already shown.
// Backing off bounds preemptions without ignoring diaries whose older posts
// are still to come.
export function rearmDelay (emptyStreak) {
  const n = Number.isSafeInteger(emptyStreak) && emptyStreak >= 0 ? emptyStreak : 0
  return FEED_REARM_MS * 2 ** Math.min(n, FEED_REARM_MAX_STEPS)
}

// An old node omits both fields, which reads as not syncing.
export function feedStillSyncing (page) {
  return (Array.isArray(page.incomplete) && page.incomplete.length > 0) ||
    (Number.isSafeInteger(page.incompleteTruncated) && page.incompleteTruncated > 0)
}

// A capped list hides keys, so growth of any key outside the baseline counts.
export function syncTruncated (page) {
  const n = (v) => Number.isSafeInteger(v) && v > 0 ? v : 0
  return n(page.incompleteTruncated) + n(page.skippedTruncated)
}

// A short newest page holds the whole local feed, and a page that still holds
// every shown row drops nothing, so either can replace the list; otherwise a
// full page would push rows the person may be reading off its end.
export function replacesQuietly (page, limit, shown = []) {
  if (!Array.isArray(page.items)) return false
  if (page.items.length < limit) return true
  const keys = new Set(page.items.map(feedKey))
  return shown.every((item) => keys.has(feedKey(item)))
}

// The baseline is the lengths map taken before the request, so growth that
// lands while the read runs still triggers the next pass. A key with no local
// length yet starts at -1 so its first downloaded block counts. A follow with
// no local replica is skipped as no-cert, never listed as incomplete, and its
// first arrival must still reach the list.
export function syncBaseline (page, lengths) {
  const known = lengths || {}
  const baseline = {}
  const add = (key) => {
    if (typeof key === 'string') baseline[key] = known[key] ?? -1
  }
  for (const key of Array.isArray(page.incomplete) ? page.incomplete : []) add(key)
  for (const entry of Array.isArray(page.skipped) ? page.skipped : []) {
    if (entry && entry.reason === 'no-cert') add(entry.key)
  }
  if (syncTruncated(page) > 0) {
    for (const key of Object.keys(known)) {
      if (!(key in baseline)) baseline[key] = known[key]
    }
  }
  return baseline
}

const HEX64 = /^[0-9a-f]{64}$/

// Growth is only a trigger to read again, because every read preempts the
// sync run: the read itself decides what the list shows.
export function advancedKeys (baseline, truncated, lengths) {
  if (!lengths) return []
  const grown = []
  for (const key of Object.keys(baseline)) {
    if (Number.isSafeInteger(lengths[key]) && lengths[key] > baseline[key]) grown.push(key)
  }
  if (truncated > 0) {
    for (const key of Object.keys(lengths)) {
      if (!(key in baseline) && HEX64.test(key) && Number.isSafeInteger(lengths[key])) grown.push(key)
    }
  }
  return grown.sort()
}

export function syncAdvanced (baseline, truncated, lengths) {
  return advancedKeys(baseline, truncated, lengths).length > 0
}
