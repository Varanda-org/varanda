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
