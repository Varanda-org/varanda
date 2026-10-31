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

// The one timer of the automatic reads. A manual read cancels it: the timer
// would fire after that read and cost one more preemption of the sync run;
// the effect arms it again when the read ends and the diary still grows.
export function rearmTimer (set = setTimeout, clear = clearTimeout) {
  let id = null
  return {
    get armed () { return id !== null },
    arm (fn, ms) {
      id = set(() => {
        id = null
        fn()
      }, ms)
    },
    cancel () {
      if (id === null) return
      clear(id)
      id = null
    }
  }
}

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

// Infinite scroll in RefreshableList. A page the list asked for that shows
// nothing new (a diary page of likes, a feed read that only met known rows)
// counts as dry; after AUTO_DRY_MAX dry pages in a row the list stops
// loading by itself and offers a 'carregar mais' button, so a long run of
// hidden records never turns into a request loop.
export const AUTO_DRY_MAX = 3

// A list shorter than its viewport is always near its end: it cannot scroll,
// so no end reach would ever come from scrolling.
export function nearListEnd ({ offset, content, layout }, threshold) {
  return layout > 0 && content - (offset + layout) <= threshold * layout
}

// A failed page waits for the person (the footer's 'tentar de novo'), so a
// failing node is never hammered.
export function endStep ({ canLoad, atEnd, failed, busy, near, fired, dry, max = AUTO_DRY_MAX }) {
  if (!canLoad || atEnd || failed) return 'idle'
  if (busy) return 'wait'
  if (!near || fired) return 'idle'
  if (dry >= max) return 'paused'
  return 'load'
}

// The end of a busy span (a page, a refresh or a caller's own reload). An end
// reach that came while it ran is never dropped: the list checks again, right
// away when nothing new was laid out, else after the new content size.
export function spanEnd ({ dry, startLen, len, failed, refreshed, own }) {
  if (failed) return { dry, check: 'none' }
  if (refreshed || len > startLen) return { dry: 0, check: len !== startLen ? 'layout' : 'now' }
  if (own) return { dry: dry + 1, check: 'now' }
  return { dry, check: 'now' }
}

// A quiet newest read of A Rua. A full page says nothing about rows older
// than the oldest one it holds, so the list stays at its end (a full page that
// would cut shown rows keeps them) and the next automatic read probes below
// the list instead of the person paging into a before read that keeps coming
// back empty.
export function quietNewestPlan (page, limit, shown) {
  const replace = replacesQuietly(page, limit, shown)
  const full = Array.isArray(page.items) && page.items.length >= limit
  return { replace, atEnd: true, probeOlder: full, deep: !replace }
}

// A short list re-reads the newest page. A deep or full list re-reads the
// range it shows: a diary downloaded newest first fills in between the newest
// rows and the oldest shown one, where a before read never looks (newer rows
// reach a full list through the 'ver novidades' pill). Only a pending probe
// reads below the list.
export function syncReadKind ({ deep, probeOlder, shown, limit }) {
  if (probeOlder) return 'older'
  return deep || shown >= limit ? 'range' : 'newest'
}

// Never after a failed read: only a manual action clears the error. A range
// read cut by its page cap continues without new growth. Only reads at the
// list's end need it there (the probe below it, and a short list's newest
// page); a range read re-reads the shown span, so it runs wherever the
// person is in the list.
export function canSyncRead (feed, lengths, active, limit = 30) {
  return planSyncRead(feed, lengths, active, limit) !== null
}

// The next automatic read, or null. Empty range and older reads back off.
export function planSyncRead (feed, lengths, active, limit = 30) {
  if (!active || feed.loadedAt === null || feed.loading || feed.loadingMore || feed.refreshing ||
    feed.loadError || feed.moreError) return null
  const shown = Array.isArray(feed.items) ? feed.items.length : 0
  const kind = syncReadKind({ deep: feed.deep, probeOlder: feed.probeOlder, shown, limit })
  const grown = () => syncAdvanced(feed.syncBase, feed.syncTruncated, lengths)
  if (kind === 'older') {
    if (!feed.atEnd) return null
  } else if (kind === 'newest') {
    if (!feed.atEnd || !grown()) return null
  } else if (!(feed.rangeFrom !== undefined && feed.rangeFrom !== null) && !grown()) {
    return null
  }
  return { kind, delay: rearmDelay(kind === 'newest' ? 0 : feed.emptyStreak) }
}

// The footer never announces the end while the node still reports growth
// since the last read, an incomplete diary or a pending automatic read.
export function feedSyncing (feed, lengths) {
  return feedStillSyncing(feed) || feed.probeOlder === true ||
    (feed.rangeFrom !== undefined && feed.rangeFrom !== null) ||
    syncAdvanced(feed.syncBase || {}, feed.syncTruncated, lengths)
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Feed order (docs/rpc.md section 5.13), oldest first.
export function compareFeed (a, b) {
  return (Date.parse(a.at) - Date.parse(b.at)) || cmp(a.author, b.author) || a.seq - b.seq
}

export const RANGE_PAGES_MAX = 10

// Where a range read starts: below the newest shown row, since rows above it
// never enter the list there (the pill shows them), or where a capped read
// stopped.
export function rangeStart (currentNewestFirst, rangeFrom) {
  const top = currentNewestFirst.length > 0 ? cursorOf([currentNewestFirst[0]]) : null
  if (rangeFrom && (top === null || compareFeed(rangeFrom, top) < 0)) return rangeFrom
  return top
}

export function rangePageCap (shown, limit) {
  return Math.max(1, Math.min(RANGE_PAGES_MAX, Math.ceil(shown / limit) + 1))
}

// After each page of a range read: 'end' on a short page (the rest of the
// local feed was read), 'reached' when the page got to the list's cursor,
// 'cap' at the page cap, else 'more'. A page that adds nothing does not stop
// the loop: the rows still missing may sort further down.
export function rangeStep ({ page, limit, until, pages, cap }) {
  const items = Array.isArray(page.items) ? page.items : []
  if (items.length < limit) return 'end'
  if (until && compareFeed(items[0], until) <= 0) return 'reached'
  if (pages >= cap) return 'cap'
  return 'more'
}

// Merges the pages of a range read into the shown list without cutting a
// row. Rows newer than the newest shown are never inserted above the person:
// they are counted for the 'ver novidades' pill instead.
export function mergeRange (currentNewestFirst, pageAscending) {
  const top = currentNewestFirst.length > 0 ? currentNewestFirst[0] : null
  const seen = new Set(currentNewestFirst.map(feedKey))
  const newer = new Set()
  const add = []
  for (const item of pageAscending) {
    const key = feedKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    if (top !== null && compareFeed(item, top) > 0) newer.add(key)
    else add.push(item)
  }
  add.sort((a, b) => compareFeed(b, a))
  const items = []
  let i = 0
  for (const row of currentNewestFirst) {
    while (i < add.length && compareFeed(add[i], row) > 0) items.push(add[i++])
    items.push(row)
  }
  while (i < add.length) items.push(add[i++])
  return { items, added: add.length, newer: [...newer] }
}

// The baseline only advances to lengths taken at the START of a read that
// covered the whole shown range: a reload that replaced the list, or a range
// sequence (its pages and capped continuations keep the lengths taken before
// its first page in seqBase while pending). Growth in the part a sequence
// already read is then never marked handled; once it ends, any such growth
// plans another range read.
export function sequenceBase (seqBase, now, pending) {
  const start = seqBase || now || {}
  return { start, seqBase: pending ? start : null }
}

// A page below the list (scrolling, or the probe) only appends rows: it never
// advances the baseline nor ends a pending sequence, since it read nothing of
// the range already shown. Growth above the baseline then plans a range read
// once the list is at its end again.
export function olderPagePatch (prev, page, { before, fromSync = false, limit }) {
  const cursor = cursorOf(page.items)
  return {
    items: mergeOlder(prev.items, page.items).items,
    // An empty page keeps the cursor so a later sync pass can ask again.
    cursor: cursor === null ? before : cursor,
    atEnd: isLastFeedPage(page, limit) || !cursorMoved(before, cursor),
    emptyStreak: page.items.length > 0 ? 0 : fromSync ? prev.emptyStreak + 1 : prev.emptyStreak,
    deep: prev.deep || page.items.length > 0,
    probeOlder: false
  }
}

// The list after a range read. A full page that reached the list's cursor
// says nothing about rows below its oldest one, so a list that was at its end
// stays there and the next automatic read probes below it (as after a full
// quiet newest page); a list that was not keeps paging by scrolling. A read
// cut by the cap continues from its last page.
export function rangeEnd ({ step, cursor, page, atEnd = true }) {
  const last = Array.isArray(page.items) ? cursorOf(page.items) : null
  const older = last !== null && (cursor === null || compareFeed(last, cursor) < 0) ? last : cursor
  if (step === 'cap') return { cursor, atEnd, probeOlder: false, rangeFrom: last }
  if (step === 'reached') return { cursor: older, atEnd, probeOlder: atEnd, rangeFrom: null }
  return { cursor: older, atEnd: true, probeOlder: false, rangeFrom: null }
}

// The baseline is the lengths map taken before the request, so growth that
// lands while the read runs still triggers the next pass. Every known length
// is recorded: a stored replica reports its old length until its upgrade
// arrives, so a read before it lists nothing incomplete and only later growth
// says there is more. A key with no local length yet starts at -1 so its
// first downloaded block counts. A follow with no local replica is skipped as
// no-cert, never listed as incomplete, and its first arrival must still reach
// the list.
export function syncBaseline (page, lengths) {
  const known = lengths || {}
  const baseline = {}
  for (const key of Object.keys(known)) {
    if (Number.isSafeInteger(known[key])) baseline[key] = known[key]
  }
  const add = (key) => {
    if (typeof key === 'string' && !(key in baseline)) baseline[key] = -1
  }
  for (const key of Array.isArray(page.incomplete) ? page.incomplete : []) add(key)
  for (const entry of Array.isArray(page.skipped) ? page.skipped : []) {
    if (entry && entry.reason === 'no-cert') add(entry.key)
  }
  return baseline
}

const HEX64 = /^[0-9a-f]{64}$/

// Growth is only a trigger to read again, because every read preempts the
// sync run: the read itself decides what the list shows. A key outside the
// baseline appeared after the read, so its length counts as growth.
export function advancedKeys (baseline, truncated, lengths) {
  if (!lengths) return []
  const grown = []
  for (const key of Object.keys(lengths)) {
    if (!Number.isSafeInteger(lengths[key])) continue
    if (key in baseline ? lengths[key] > baseline[key] : HEX64.test(key.replace(/^newest:/, ''))) grown.push(key)
  }
  return grown.sort()
}

export function syncAdvanced (baseline, truncated, lengths) {
  return advancedKeys(baseline, truncated, lengths).length > 0
}
