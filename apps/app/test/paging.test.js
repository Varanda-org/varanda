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

test('sync baseline covers incomplete and no-cert follows, plus every length when truncated', async (t) => {
  const { syncBaseline } = await load()
  const lengths = Object.freeze({ [KEY_A]: 3, [KEY_C]: 7 })
  t.alike(syncBaseline({ incomplete: [KEY_A, KEY_B] }, lengths), { [KEY_A]: 3, [KEY_B]: -1 })
  t.alike(syncBaseline({ incomplete: [KEY_B] }, undefined), { [KEY_B]: -1 })
  t.alike(syncBaseline({ items: [] }, lengths), {})
  t.alike(syncBaseline({ incomplete: [KEY_B], incompleteTruncated: 2 }, lengths), { [KEY_A]: 3, [KEY_B]: -1, [KEY_C]: 7 })
  t.alike(syncBaseline({
    incomplete: [],
    skipped: [{ key: KEY_B, reason: 'no-cert' }, { key: KEY_C, reason: 'blocked' }]
  }, lengths), { [KEY_B]: -1 }, 'only a no-cert follow joins the baseline')
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
  t.is(syncAdvanced(baseline, 0, { [KEY_C]: 1 }), false, 'key outside the baseline, not truncated')
  t.is(syncAdvanced(baseline, 1, { [KEY_C]: 1 }), true, 'key outside the baseline, truncated')
  t.is(syncAdvanced(baseline, 1, { nothex: 5 }), false, 'non-hex key ignored')
  t.alike(advancedKeys(baseline, 1, { [KEY_C]: 1, [KEY_B]: 0, [KEY_A]: 3, nothex: 9 }), [KEY_B, KEY_C])
  t.alike(advancedKeys(baseline, 0, { [KEY_A]: 3 }), [])
  t.alike(advancedKeys(baseline, 0, undefined), [])
  const page = { incomplete: [], skipped: [{ key: KEY_B, reason: 'no-cert' }, { key: KEY_C, reason: 'blocked' }] }
  const fromSkipped = syncBaseline(page, {})
  t.is(syncAdvanced(fromSkipped, 0, { [KEY_B]: 1 }), true, 'a no-cert follow growing triggers')
  t.is(syncAdvanced(fromSkipped, 0, { [KEY_C]: 1 }), false, 'a blocked follow does not')
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
