// Cursor progress and immutable merges for feed and diary traversal.
'use strict'

const test = require('brittle')
const load = () => import('../src/paging.js')
const item = (author, seq, at) => Object.freeze({ author, seq, at, text: 'olá' })
const log = (entries, invalid, entriesTruncated = 0) => Object.freeze({
  entries: Object.freeze(entries.map((seq) => Object.freeze({ seq, record: { type: 'post' } }))),
  invalid: Object.freeze(invalid.map((seq) => Object.freeze({ seq, reason: 'malformed' }))),
  entriesTruncated
})

test('feed pages reverse, reset and merge overlaps without repeating a key', async (t) => {
  const { feedKey, toNewestFirst, resetWith, mergeOlder } = await load()
  const a = item('a', 1, '2026-10-01T00:00:00Z')
  const b = item('b', 1, '2026-10-01T00:00:00Z')
  const c = item('a', 2, '2026-10-02T00:00:00Z')
  const d = item('a', 3, '2026-10-03T00:00:00Z')
  const page = Object.freeze([a, b, c])
  const current = Object.freeze([d, c])
  t.is(feedKey(a), 'a:1')
  t.is(feedKey(b), 'b:1')
  t.alike(toNewestFirst(page), [c, b, a])
  t.alike(resetWith(page), [c, b, a])
  t.alike(mergeOlder(current, page), { items: [d, c, b, a], added: 2 })
  t.alike(mergeOlder([d, c, b, a], page), { items: [d, c, b, a], added: 0 })
  t.alike(mergeOlder(current, []), { items: [d, c], added: 0 })
  t.alike(resetWith([]), [])
  t.alike(page, [a, b, c], 'page is not reversed in place')
  t.alike(current, [d, c], 'current rows are not appended in place')
  const changed = { ...c, text: 'novo' }
  t.alike(mergeOlder([d, c, c], [a, a, changed]), { items: [d, c, a], added: 1 })
  t.alike(resetWith([a, a, c]), [c, a])
})

test('feed cursors use the oldest item and require progress to keep traversing', async (t) => {
  const { cursorOf, cursorMoved, isLastFeedPage } = await load()
  const oldest = item('a', 1, '2026-10-01T00:00:00Z')
  const page = Object.freeze([oldest, item('b', 2, '2026-10-02T00:00:00Z')])
  const cursor = cursorOf(page)
  t.alike(cursor, { at: oldest.at, author: 'a', seq: 1 })
  t.is(cursorOf([]), null)
  t.is(cursorMoved(null, null), false)
  t.is(cursorMoved(cursor, null), false)
  t.is(cursorMoved(null, cursor), true)
  t.is(cursorMoved(cursor, { ...cursor }), false)
  for (const change of [{ at: '2026-09-30T00:00:00Z' }, { author: 'b' }, { seq: 0 }]) {
    t.is(cursorMoved(cursor, { ...cursor, ...change }), true)
  }
  t.is(isLastFeedPage({ items: page }, 2), false)
  t.is(isLastFeedPage({ items: page }, 3), true)
  t.is(isLastFeedPage({ items: [] }, 2), true)
})

test('diary rows interleave invalid blocks and merge by sequence descending', async (t) => {
  const { logRows, mergeOlderRows, oldestSeq, isLastLogPage } = await load()
  const newest = log([3, 5], [4], 3)
  const older = log([0, 2, 3], [1], 0)
  const rows = Object.freeze(logRows(newest).map(Object.freeze))
  t.alike(rows, [
    { seq: 5, entry: newest.entries[1] },
    { seq: 4, invalid: newest.invalid[0] },
    { seq: 3, entry: newest.entries[0] }
  ])
  const merged = mergeOlderRows(rows, older)
  t.alike(merged.map((row) => row.seq), [5, 4, 3, 2, 1, 0])
  t.is(merged[2], rows[2], 'existing row wins an overlap')
  t.is(merged[4].invalid, older.invalid[0])
  t.alike(mergeOlderRows(merged, older), merged)
  t.alike(mergeOlderRows(rows, log([], [])), rows)
  t.alike(logRows(log([], [])), [])
  t.is(oldestSeq(rows), 3)
  t.is(oldestSeq(merged), 0)
  t.is(oldestSeq([]), null)
  t.is(isLastLogPage(newest), false)
  t.is(isLastLogPage(older), true)
  t.is(isLastLogPage(log([], [0])), true, 'invalid blocks still exhaust the window')
})

test('show reloads only for an initial load, a fresh hint or an expired load', async (t) => {
  const { shouldReloadOnShow } = await load()
  const cases = [
    [{ loadedAt: null, now: 0, fresh: false }, true],
    [{ loadedAt: 0, now: 0, fresh: false }, false],
    [{ loadedAt: 0, now: 59999, fresh: false }, false],
    [{ loadedAt: 0, now: 60000, fresh: false }, true],
    [{ loadedAt: 0, now: 1, fresh: true }, true],
    [{ loadedAt: 0, now: 1, fresh: 1 }, false],
    [{ loadedAt: 1000, now: 999, fresh: false }, false],
    [{ loadedAt: 1000, now: 1499, maxAgeMs: 500 }, false],
    [{ loadedAt: 1000, now: 1500, maxAgeMs: 500 }, true]
  ]
  for (const [input, expected] of cases) t.is(shouldReloadOnShow(Object.freeze(input)), expected)
})

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const KEY_C = 'c'.repeat(64)

test('feed footer says syncing only while the last page reported incomplete diaries', async (t) => {
  const { FEED_SYNCING_END, feedStillSyncing, isLastFeedPage } = await load()
  t.is(FEED_SYNCING_END, 'Ainda sincronizando quem você segue.')
  t.is(feedStillSyncing({ items: [] }), false, 'an old node without the fields is not syncing')
  t.is(feedStillSyncing({ incomplete: [], incompleteTruncated: 0 }), false)
  t.is(feedStillSyncing({ incomplete: [KEY_A] }), true)
  t.is(feedStillSyncing({ incomplete: [], incompleteTruncated: 1 }), true)
  t.is(isLastFeedPage({ items: [], incomplete: [KEY_A] }, 2), true, 'a short syncing page still ends the list')
})

test('sync baseline records every known length plus incomplete and no-cert follows', async (t) => {
  const { syncBaseline } = await load()
  const lengths = Object.freeze({ [KEY_A]: 3, [KEY_C]: 7 })
  t.alike(syncBaseline({ incomplete: [KEY_A, KEY_B] }, lengths), { [KEY_A]: 3, [KEY_B]: -1, [KEY_C]: 7 })
  t.alike(syncBaseline({ incomplete: [KEY_B] }, undefined), { [KEY_B]: -1 })
  t.alike(syncBaseline({ items: [] }, lengths), { [KEY_A]: 3, [KEY_C]: 7 }, 'nothing incomplete still records every length')
  t.alike(syncBaseline({ incomplete: [KEY_B], incompleteTruncated: 2 }, lengths), { [KEY_A]: 3, [KEY_B]: -1, [KEY_C]: 7 })
  t.alike(syncBaseline({ items: [] }, { [KEY_A]: '3' }), {}, 'non-number lengths are not recorded')
  t.alike(syncBaseline({
    incomplete: [],
    skipped: [{ key: KEY_B, reason: 'no-cert' }, { key: 'd'.repeat(64), reason: 'blocked' }]
  }, lengths), { [KEY_A]: 3, [KEY_B]: -1, [KEY_C]: 7 }, 'only a no-cert follow joins the baseline at -1')
})

test('sync advances only on growth past the baseline', async (t) => {
  const { syncBaseline, syncAdvanced, advancedKeys } = await load()
  const baseline = Object.freeze({ [KEY_A]: 3, [KEY_B]: -1 })
  t.is(syncAdvanced(baseline, 0, { [KEY_A]: 3 }), false, 'equal length')
  t.is(syncAdvanced(baseline, 0, { [KEY_A]: 2 }), false, 'smaller length')
  t.is(syncAdvanced(baseline, 0, { [KEY_A]: 4 }), true)
  t.is(syncAdvanced(baseline, 0, { [KEY_B]: 1 }), true, 'first block of an unknown key')
  t.is(syncAdvanced(baseline, 0, { [KEY_A]: '9' }), false, 'non-number')
  t.is(syncAdvanced(baseline, 0, undefined), false)
  t.is(syncAdvanced(baseline, 0, { [KEY_C]: 1 }), true, 'a key that appeared after the read')
  t.is(syncAdvanced(baseline, 1, { [KEY_C]: 1 }), true, 'key outside the baseline, truncated')
  t.is(syncAdvanced(baseline, 1, { nothex: 5 }), false, 'non-hex key ignored')
  t.alike(advancedKeys(baseline, 1, { [KEY_C]: 1, [KEY_B]: 0, [KEY_A]: 3, nothex: 9 }), [KEY_B, KEY_C])
  t.alike(advancedKeys(baseline, 0, { [KEY_A]: 3 }), [])
  t.alike(advancedKeys(baseline, 0, undefined), [])
  const page = { incomplete: [], skipped: [{ key: KEY_B, reason: 'no-cert' }, { key: KEY_C, reason: 'blocked' }] }
  const fromSkipped = syncBaseline(page, {})
  t.is(syncAdvanced(fromSkipped, 0, { [KEY_B]: 1 }), true, 'a no-cert follow growing triggers')
  t.is(syncAdvanced(syncBaseline(page, { [KEY_C]: 1 }), 0, { [KEY_C]: 1 }), false, 'a blocked follow that does not grow does not')
})

test('a capped skipped or incomplete list opens the trigger to every key', async (t) => {
  const { syncTruncated, syncBaseline, syncAdvanced } = await load()
  const KEY_A = 'a'.repeat(64)
  const KEY_B = 'b'.repeat(64)
  t.is(syncTruncated({}), 0, 'an old node')
  t.is(syncTruncated({ incompleteTruncated: 2, skippedTruncated: 3 }), 5)
  t.is(syncTruncated({ incompleteTruncated: -1, skippedTruncated: 1.5 }), 0)
  const page = { incomplete: [], skipped: [], skippedTruncated: 1 }
  const baseline = syncBaseline(page, { [KEY_A]: 4 })
  t.is(baseline[KEY_A], 4, 'known lengths are recorded')
  t.is(syncAdvanced(baseline, syncTruncated(page), { [KEY_A]: 4, [KEY_B]: 1 }), true, 'a follow cut from skipped grows')
  t.is(syncAdvanced(baseline, syncTruncated(page), { [KEY_A]: 4 }), false)
})

test('only a short newest page replaces the list quietly', async (t) => {
  const { replacesQuietly } = await load()
  const row = (seq) => ({ author: 'a'.repeat(64), seq })
  const full = { items: Array.from({ length: 30 }, (_, i) => row(i + 1)) }
  t.is(replacesQuietly({ items: [row(1)] }, 30, [row(9)]), true, 'a short page is the whole local feed')
  t.is(replacesQuietly(full, 30, [row(40)]), false, 'a full page would cut a shown row')
  t.is(replacesQuietly(full, 30, []), true, 'an empty list loses nothing')
  t.is(replacesQuietly(full, 30, [row(2), row(30)]), true, 'every shown row is still on the page')
  t.is(replacesQuietly({}, 30, []), false)
})

test('empty automatic reads back off with a capped delay', async (t) => {
  const { FEED_REARM_MS, rearmDelay } = await load()
  t.is(rearmDelay(0), FEED_REARM_MS)
  t.is(rearmDelay(1), FEED_REARM_MS * 2)
  t.is(rearmDelay(4), FEED_REARM_MS * 16)
  t.is(rearmDelay(10), FEED_REARM_MS * 16, 'delay stays capped')
  for (const invalid of [-1, 1.5, undefined]) {
    t.is(rearmDelay(invalid), FEED_REARM_MS, 'invalid streak uses the initial delay')
  }
})

test('a manual read cancels the armed timer, and the timer can be armed again', async (t) => {
  const { rearmTimer } = await load()
  const pending = new Map()
  let next = 0
  const timer = rearmTimer((fn) => { pending.set(++next, fn); return next }, (id) => pending.delete(id))
  const fire = () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn() } }
  let reads = 0
  t.is(timer.armed, false)
  timer.arm(() => { reads++ }, 2000)
  t.is(timer.armed, true)
  timer.cancel()
  t.is(timer.armed, false)
  fire()
  t.is(reads, 0, 'a cancelled timer never reads')
  timer.cancel()
  timer.arm(() => { reads++ }, 2000)
  fire()
  t.is(reads, 1, 'an armed timer reads once')
  t.is(timer.armed, false, 'it is free again after firing')
})

test('a list shorter than its viewport is near its end; an unmeasured one is not', async (t) => {
  const { nearListEnd } = await load()
  t.is(nearListEnd({ offset: 0, content: 300, layout: 800 }, 0.6), true, 'a short list cannot scroll to reach its end')
  t.is(nearListEnd({ offset: 0, content: 0, layout: 800 }, 0.6), true, 'an empty list loads too')
  t.is(nearListEnd({ offset: 0, content: 300, layout: 0 }, 0.6), false, 'no layout yet')
  t.is(nearListEnd({ offset: 0, content: 5000, layout: 800 }, 0.6), false, 'far from the end')
  t.is(nearListEnd({ offset: 3800, content: 5000, layout: 800 }, 0.6), true, 'within 0.6 screens of the end')
})

test('endStep loads near the end and waits, idles or pauses otherwise', async (t) => {
  const { AUTO_DRY_MAX, endStep } = await load()
  const base = Object.freeze({ canLoad: true, atEnd: false, failed: false, busy: false, near: true, fired: false, dry: 0 })
  t.is(AUTO_DRY_MAX, 3)
  t.is(endStep(base), 'load')
  t.is(endStep({ ...base, atEnd: true }), 'idle', 'at the end')
  t.is(endStep({ ...base, canLoad: false }), 'idle', 'no loader')
  t.is(endStep({ ...base, failed: true }), 'idle', 'a failed page waits for the person')
  t.is(endStep({ ...base, failed: true, busy: true }), 'idle')
  t.is(endStep({ ...base, busy: true }), 'wait')
  t.is(endStep({ ...base, busy: true, fired: true, near: false }), 'wait')
  t.is(endStep({ ...base, near: false }), 'idle')
  t.is(endStep({ ...base, fired: true }), 'idle', 'once per end reach')
  t.is(endStep({ ...base, dry: 2 }), 'load')
  t.is(endStep({ ...base, dry: 3 }), 'paused', 'three dry pages')
  t.is(endStep({ ...base, dry: 1, max: 1 }), 'paused')
})

test('an end reach during a span the list did not start is not dropped', async (t) => {
  const { spanEnd } = await load()
  // The old rule: a pending reach was dropped when a span ended on the same
  // data without a refresh, so a caller's own reload swallowed it.
  const oldServes = ({ refreshed, sameData }) => !(!refreshed && sameData)
  t.is(oldServes({ refreshed: false, sameData: true }), false, 'the old rule dropped it')
  t.alike(spanEnd({ dry: 0, startLen: 10, len: 10, failed: false, refreshed: false, own: false }), { dry: 0, check: 'now' })
})

test('an own page that shows nothing counts as dry and the list asks again', async (t) => {
  const { endStep, spanEnd } = await load()
  const r = spanEnd({ dry: 0, startLen: 10, len: 10, failed: false, refreshed: false, own: true })
  t.alike(r, { dry: 1, check: 'now' })
  // The span end re-arms the reach, so the end still in view loads the next page.
  t.is(endStep({ canLoad: true, atEnd: false, failed: false, busy: false, near: true, fired: false, dry: r.dry }), 'load')
  // The old list loaded only from FlatList's end reach, which does not come
  // again for the same content height: nothing loaded.
  const oldLoadsAgain = ({ contentChanged }) => contentChanged
  t.is(oldLoadsAgain({ contentChanged: false }), false)
})

test('three dry pages pause, a page with rows resets, a failure stops checking', async (t) => {
  const { endStep, spanEnd } = await load()
  let dry = 0
  for (let i = 0; i < 3; i++) dry = spanEnd({ dry, startLen: 5, len: 5, failed: false, refreshed: false, own: true }).dry
  t.is(dry, 3)
  t.is(endStep({ canLoad: true, atEnd: false, failed: false, busy: false, near: true, fired: false, dry }), 'paused')
  t.alike(spanEnd({ dry: 2, startLen: 5, len: 9, failed: false, refreshed: false, own: true }), { dry: 0, check: 'layout' })
  t.alike(spanEnd({ dry: 2, startLen: 5, len: 5, failed: false, refreshed: true, own: false }), { dry: 0, check: 'now' })
  t.alike(spanEnd({ dry: 2, startLen: 5, len: 3, failed: false, refreshed: true, own: false }), { dry: 0, check: 'layout' })
  t.alike(spanEnd({ dry: 2, startLen: 5, len: 5, failed: true, refreshed: false, own: true }), { dry: 2, check: 'none' })
})

test('a quiet newest page keeps the list at its end and probes below it when full', async (t) => {
  const { quietNewestPlan } = await load()
  const row = (seq) => ({ author: 'a'.repeat(64), seq })
  const full = { items: Array.from({ length: 30 }, (_, i) => row(i + 1)) }
  t.alike(quietNewestPlan(full, 30, [row(40)]), { replace: false, atEnd: true, probeOlder: true, deep: true },
    'a full page that would cut a shown row')
  // The old quiet path left the end here, and the before read that followed
  // found nothing below the list and looped.
  t.alike(quietNewestPlan({ items: [row(1)] }, 30, [row(9)]), { replace: true, atEnd: true, probeOlder: false, deep: false })
  t.alike(quietNewestPlan(full, 30, [row(2), row(30)]), { replace: true, atEnd: true, probeOlder: true, deep: false },
    'a full page holding every shown row replaces and probes')
})

test('sync reads re-read the newest page for a short list and the shown range for a deep one', async (t) => {
  const { syncReadKind } = await load()
  t.is(syncReadKind({ deep: false, probeOlder: false, shown: 12, limit: 30 }), 'newest')
  t.is(syncReadKind({ deep: false, probeOlder: false, shown: 30, limit: 30 }), 'range')
  t.is(syncReadKind({ deep: true, probeOlder: false, shown: 3, limit: 30 }), 'range')
  t.is(syncReadKind({ deep: false, probeOlder: true, shown: 3, limit: 30 }), 'older')
  t.is(syncReadKind({ deep: true, probeOlder: true, shown: 90, limit: 30 }), 'older', 'only a pending probe reads below the list')
})

test('a probe below the list runs once without growth, never after an error', async (t) => {
  const { canSyncRead } = await load()
  const feed = Object.freeze({
    loadedAt: 1,
    atEnd: true,
    loading: false,
    loadingMore: false,
    refreshing: false,
    loadError: '',
    moreError: '',
    syncBase: Object.freeze({ [KEY_A]: 3 }),
    syncTruncated: 0,
    probeOlder: true
  })
  const same = { [KEY_A]: 3 }
  t.is(canSyncRead(feed, same, true), true, 'the probe needs no growth')
  t.is(canSyncRead({ ...feed, probeOlder: false }, same, true), false, 'once done, growth is needed again')
  t.is(canSyncRead({ ...feed, probeOlder: false }, { [KEY_A]: 4 }, true), true)
  t.is(canSyncRead({ ...feed, moreError: 'falhou' }, same, true), false)
  t.is(canSyncRead({ ...feed, loadError: 'falhou' }, same, true), false)
  t.is(canSyncRead({ ...feed, atEnd: false }, same, true), false, 'never when not at the end')
  t.is(canSyncRead(feed, same, false), false, 'not shown')
  t.is(canSyncRead({ ...feed, loadingMore: true }, same, true), false)
})

const at = (minute) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + minute * 60000).toISOString()
const post = (author, seq, minute) => Object.freeze({ author, seq, at: at(minute), text: 'olá' })
const syncFeed = (patch) => Object.freeze({
  items: [],
  cursor: null,
  loadedAt: 1,
  atEnd: true,
  loading: false,
  loadingMore: false,
  refreshing: false,
  loadError: '',
  moreError: '',
  incomplete: [],
  incompleteTruncated: 0,
  syncBase: {},
  syncTruncated: 0,
  emptyStreak: 0,
  deep: false,
  probeOlder: false,
  rangeFrom: null,
  ...patch
})

test('a deep list whose diaries grew re-reads its range, not below its cursor', async (t) => {
  const { planSyncRead, rearmDelay } = await load()
  const items = Array.from({ length: 147 }, (_, i) => post(KEY_A, 147 - i, 147 - i))
  const feed = syncFeed({ items, cursor: { at: items[146].at, author: KEY_A, seq: 1 }, deep: true, syncBase: { [KEY_A]: 51 }, emptyStreak: 1 })
  t.alike(planSyncRead(feed, { [KEY_A]: 147 }, true, 30), { kind: 'range', delay: rearmDelay(1) })
  t.is(planSyncRead(feed, { [KEY_A]: 51 }, true, 30), null, 'no growth, no read')
  t.alike(planSyncRead({ ...feed, deep: false, items: items.slice(0, 5) }, { [KEY_A]: 147 }, true, 30), { kind: 'newest', delay: rearmDelay(0) })
  t.is(planSyncRead({ ...feed, moreError: 'falhou' }, { [KEY_A]: 147 }, true, 30), null, 'never after a failed read')
  t.is(planSyncRead({ ...feed, loadingMore: true }, { [KEY_A]: 147 }, true, 30), null)
  t.alike(planSyncRead({ ...feed, rangeFrom: { at: items[60].at, author: KEY_A, seq: 87 } }, { [KEY_A]: 51 }, true, 30), { kind: 'range', delay: rearmDelay(1) },
    'a capped range read continues without new growth')
})

test('a read before the upgrade lists nothing incomplete and later growth still re-arms', async (t) => {
  const { canSyncRead, syncBaseline, syncTruncated } = await load()
  const page = { items: [], incomplete: [], skipped: [] }
  const stored = syncFeed({ syncBase: syncBaseline(page, { [KEY_A]: 102 }), syncTruncated: syncTruncated(page) })
  t.is(canSyncRead(stored, { [KEY_A]: 102 }, true), false)
  t.is(canSyncRead(stored, { [KEY_A]: 162 }, true), true, 'a stored replica grew after the read')
  const early = syncFeed({ syncBase: syncBaseline(page, {}), syncTruncated: syncTruncated(page) })
  t.is(canSyncRead(early, {}, true), false)
  t.is(canSyncRead(early, { [KEY_A]: 162 }, true), true, 'a length first reported after the read')
})

test('a range merge inserts rows inside the shown range in feed order and holds newer rows for the pill', async (t) => {
  const { mergeRange } = await load()
  const shown = Object.freeze([post(KEY_B, 9, 90), post(KEY_A, 5, 50), post(KEY_B, 2, 20)])
  const page = Object.freeze([
    post(KEY_A, 1, 10), post(KEY_B, 2, 20), post(KEY_A, 3, 30), post(KEY_C, 1, 50),
    post(KEY_A, 5, 50), post(KEY_A, 6, 60), post(KEY_B, 9, 90), post(KEY_C, 2, 95), post(KEY_C, 2, 95)
  ])
  const merged = mergeRange(shown, page)
  t.alike(merged.items.map((i) => i.author[0] + i.seq), ['b9', 'a6', 'c1', 'a5', 'a3', 'b2', 'a1'])
  t.is(merged.added, 4)
  t.alike(merged.newer, [KEY_C + ':2'])
  for (const row of shown) t.ok(merged.items.includes(row), 'a shown row is kept as is')
  t.alike(mergeRange(shown, []), { items: [...shown], added: 0, newer: [] })
  const kept = mergeRange(shown, [post(KEY_A, 6, 60)])
  t.is(kept.items.length, 4, 'a row the pages did not return is never cut')
  t.alike(shown.map((i) => i.seq), [9, 5, 2], 'the shown list is not changed in place')
})

test('a range read pages to the list cursor, stops on a short page or at the cap', async (t) => {
  const { RANGE_PAGES_MAX, cursorOf, rangeEnd, rangePageCap, rangeStep } = await load()
  const pageOf = (from, n) => ({ items: Array.from({ length: n }, (_, i) => post(KEY_A, from + i, from + i)) })
  const until = cursorOf([post(KEY_A, 40, 40)])
  t.is(rangePageCap(147, 31), 6)
  t.is(rangePageCap(0, 31), 1)
  t.is(rangePageCap(5000, 31), RANGE_PAGES_MAX)
  t.is(rangeStep({ page: pageOf(100, 31), limit: 31, until, pages: 1, cap: 6 }), 'more')
  t.is(rangeStep({ page: pageOf(41, 31), limit: 31, until, pages: 2, cap: 6 }), 'more', 'still above the cursor')
  t.is(rangeStep({ page: pageOf(40, 31), limit: 31, until, pages: 2, cap: 6 }), 'reached')
  t.is(rangeStep({ page: pageOf(10, 31), limit: 31, until, pages: 6, cap: 6 }), 'reached', 'reaching wins over the cap')
  t.is(rangeStep({ page: pageOf(50, 12), limit: 31, until, pages: 1, cap: 6 }), 'end')
  t.is(rangeStep({ page: { items: [] }, limit: 31, until, pages: 1, cap: 6 }), 'end')
  t.is(rangeStep({ page: pageOf(100, 31), limit: 31, until, pages: 6, cap: 6 }), 'cap')
  t.alike(rangeEnd({ step: 'reached', cursor: until, page: pageOf(30, 31) }), { cursor: cursorOf([post(KEY_A, 30, 30)]), atEnd: true, probeOlder: true, rangeFrom: null })
  t.alike(rangeEnd({ step: 'end', cursor: until, page: pageOf(50, 3) }), { cursor: until, atEnd: true, probeOlder: false, rangeFrom: null })
  t.alike(rangeEnd({ step: 'end', cursor: until, page: { items: [] } }), { cursor: until, atEnd: true, probeOlder: false, rangeFrom: null })
  t.alike(rangeEnd({ step: 'cap', cursor: until, page: pageOf(100, 31) }), { cursor: until, atEnd: true, probeOlder: false, rangeFrom: cursorOf([post(KEY_A, 100, 100)]) })
})

test('the footer says syncing while the diaries grew since the last read', async (t) => {
  const { feedSyncing } = await load()
  const feed = syncFeed({ syncBase: { [KEY_A]: 51 } })
  t.is(feedSyncing(feed, { [KEY_A]: 147 }), true, 'nothing incomplete but grown since the read')
  t.is(feedSyncing(feed, { [KEY_A]: 51 }), false)
  t.is(feedSyncing({ ...feed, incomplete: [KEY_A] }, { [KEY_A]: 51 }), true)
  t.is(feedSyncing({ ...feed, probeOlder: true }, { [KEY_A]: 51 }), true, 'a probe below the list is pending')
  t.is(feedSyncing({ ...feed, rangeFrom: { at: at(1), author: KEY_A, seq: 1 } }, { [KEY_A]: 51 }), true, 'a capped range read is pending')
  t.is(feedSyncing(feed, undefined), false)
})

test('growth during a capped range sequence plans another range read', async (t) => {
  const { planSyncRead, sequenceBase, syncBaseline } = await load()
  const items = Array.from({ length: 90 }, (_, i) => post(KEY_A, 90 - i, 90 - i))
  const cursor = { at: items[89].at, author: KEY_A, seq: 1 }
  const start = Object.freeze({ [KEY_A]: 100 })
  const first = sequenceBase(null, start, true)
  t.alike(first, { start, seqBase: start }, 'a capped first read keeps its start lengths')
  const grown = Object.freeze({ [KEY_A]: 110 })
  const last = sequenceBase(first.seqBase, grown, false)
  t.alike(last, { start, seqBase: null }, 'the continuation measures from the sequence start')
  const feed = syncFeed({ items, cursor, deep: true, syncBase: syncBaseline({ incomplete: [] }, last.start) })
  t.is((planSyncRead(feed, grown, true, 30) || {}).kind, 'range', 'posts that arrived in the part already read are read again')
  t.alike(sequenceBase(null, grown, false), { start: grown, seqBase: null }, 'a read outside a sequence uses the current lengths')
  t.alike(sequenceBase(null, undefined, false), { start: {}, seqBase: null })
})

test('a probe after a range sequence does not consume growth from the sequence', async (t) => {
  const { planSyncRead, rangeEnd, sequenceBase, syncBaseline, cursorOf, olderPagePatch } = await load()
  const items = Array.from({ length: 60 }, (_, i) => post(KEY_A, 60 - i, 60 - i))
  const until = cursorOf([items[59]])
  const page = { items: Array.from({ length: 31 }, (_, i) => post(KEY_A, i + 1, i + 1)) }
  const end = rangeEnd({ step: 'reached', cursor: until, page })
  const start = Object.freeze({ [KEY_A]: 70 })
  const range = sequenceBase(null, start, end.rangeFrom !== null)
  t.is(range.seqBase, null, 'a sequence that reached the cursor is over')
  const grown = Object.freeze({ [KEY_A]: 80 })
  const probing = syncFeed({ items, ...end, deep: true, syncBase: syncBaseline(page, range.start) })
  t.is((planSyncRead(probing, grown, true, 30) || {}).kind, 'older')
  const after = { ...probing, ...olderPagePatch(probing, { items: [] }, { before: end.cursor, fromSync: true, limit: 31 }) }
  t.alike(after.syncBase, { [KEY_A]: 70 }, 'the probe keeps the baseline of the sequence start')
  t.is((planSyncRead(after, grown, true, 30) || {}).kind, 'range', 'rows that became readable above the cursor are read')
  t.is(planSyncRead({ ...after, syncBase: syncBaseline({ items: [] }, grown) }, grown, true, 30), null, 'no growth since the start, no read')
})

test('paging below the list never advances the baseline or ends a pending sequence', async (t) => {
  const { planSyncRead, olderPagePatch, cursorOf } = await load()
  const items = Array.from({ length: 60 }, (_, i) => post(KEY_A, 100 - i, 100 - i))
  const before = cursorOf([items[59]])
  const seqBase = Object.freeze({ [KEY_A]: 70 })
  const feed = syncFeed({ items, cursor: before, atEnd: false, deep: true, syncBase: { [KEY_A]: 70 }, seqBase })
  const full = { items: Array.from({ length: 31 }, (_, i) => post(KEY_A, i + 10, i + 10)), incomplete: [] }
  const patch = olderPagePatch(feed, full, { before, fromSync: false, limit: 31 })
  t.absent('syncBase' in patch, 'a page below the list leaves the baseline alone')
  t.absent('seqBase' in patch, 'nor ends a pending sequence')
  const scrolled = { ...feed, ...patch }
  t.is(scrolled.items.length, 91)
  t.is(scrolled.atEnd, false)
  const last = { ...scrolled, ...olderPagePatch(scrolled, { items: [post(KEY_A, 1, 1)] }, { before: scrolled.cursor, fromSync: false, limit: 31 }) }
  t.is(last.atEnd, true)
  t.alike(last.syncBase, { [KEY_A]: 70 })
  t.is((planSyncRead(last, { [KEY_A]: 90 }, true, 30) || {}).kind, 'range', 'growth during the scroll is read once the list is at its end')
})

test('a range read runs away from the list end; only the probe and a short newest read wait for it', async (t) => {
  const { planSyncRead, rangeEnd, cursorOf, rearmDelay } = await load()
  const items = Array.from({ length: 120 }, (_, i) => post(KEY_A, 120 - i, 120 - i))
  const cursor = cursorOf([items[119]])
  const top = syncFeed({ items, cursor, atEnd: false, deep: true, syncBase: { [KEY_A]: 70 } })
  t.alike(planSyncRead(top, { [KEY_A]: 80 }, true, 30), { kind: 'range', delay: rearmDelay(0) }, 'growth while the person reads the top of a long list')
  t.is(planSyncRead(top, { [KEY_A]: 70 }, true, 30), null, 'no growth, no read')
  t.is((planSyncRead({ ...top, rangeFrom: cursorOf([items[60]]) }, { [KEY_A]: 70 }, true, 30) || {}).kind, 'range', 'a pending capped read continues')
  t.is(planSyncRead({ ...top, probeOlder: true }, { [KEY_A]: 80 }, true, 30), null, 'the probe below the list waits for its end')
  t.is(planSyncRead({ ...top, deep: false, items: items.slice(0, 5) }, { [KEY_A]: 80 }, true, 30), null, 'a short newest read waits for the end')
  t.is(planSyncRead({ ...top, moreError: 'falhou' }, { [KEY_A]: 80 }, true, 30), null)
  t.is(planSyncRead({ ...top, refreshing: true }, { [KEY_A]: 80 }, true, 30), null)
  const page = { items: Array.from({ length: 31 }, (_, i) => post(KEY_A, i + 1, i + 1)) }
  t.alike(rangeEnd({ step: 'reached', cursor, page, atEnd: false }), { cursor: cursorOf(page.items), atEnd: false, probeOlder: false, rangeFrom: null },
    'a list not at its end keeps paging by scrolling, no probe')
  t.alike(rangeEnd({ step: 'cap', cursor, page, atEnd: false }), { cursor, atEnd: false, probeOlder: false, rangeFrom: cursorOf(page.items) })
  t.is(rangeEnd({ step: 'end', cursor, page: { items: [] }, atEnd: false }).atEnd, true, 'a short page read the rest of the feed')
})
