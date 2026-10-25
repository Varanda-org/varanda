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
