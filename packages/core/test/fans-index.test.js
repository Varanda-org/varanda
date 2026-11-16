'use strict'

// The fas of the seeder's engagement index (fans(), fanCount()): every live
// `fan` block under its writer, the last live operation per (writer, key)
// published under the key, newest first by the clamped at then key, with
// deletion falling back, the writer's distinct-key cap, purge and the record
// slots. No network.
const test = require('brittle')
const { createEngagementIndex, FAN_PAGE, FAN_KEYS_MAX } = require('../lib/engagement-index')
const { fanRecord, validRecordCopy } = require('../lib/records')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const at = (i) => new Date(Date.UTC(2026, 2, 1, 12, 0, i)).toISOString()
const key = (i) => i.toString(16).padStart(64, '0')

function add (ix, author, seq, record) {
  return ix.add(author, seq, validRecordCopy(record, seq))
}

const fan = (k, on, i) => fanRecord({ key: k, on, at: at(i) })
const keysOf = (page) => page.items.map((r) => r.key)

test('fans: bad input answers null or zero, an unknown author an empty page', (t) => {
  const ix = createEngagementIndex()
  for (const a of [null, undefined, 'x', A.toUpperCase(), 7]) {
    t.is(ix.fans(a), null)
    t.is(ix.fanCount(a), 0)
  }
  t.alike(ix.fans(A), { items: [], next: null, total: 0 })
  t.is(ix.fanCount(A), 0)
  for (const after of ['1.' + B, { atMs: -1, key: B }, { atMs: 1.5, key: B }, { atMs: 1, key: 'x' }, { atMs: 1 }]) {
    t.is(ix.fans(A, { after }), null, 'a malformed cursor: ' + JSON.stringify(after))
  }
})

test('fans: on lists the writer with its own block, off removes, a newer on moves it, an older seq never overrides', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, B, 1, fan(A, true, 1)))
  t.alike(ix.fans(A), { items: [{ key: B, seq: 1, at: at(1) }], next: null, total: 1 })
  t.is(ix.fanCount(A), 1)
  t.ok(add(ix, B, 3, fan(A, false, 3)))
  t.alike(ix.fans(A).items, [], 'the last operation is off')
  t.ok(add(ix, B, 5, fan(A, true, 5)))
  t.alike(ix.fans(A).items, [{ key: B, seq: 5, at: at(5) }])
  t.ok(add(ix, B, 4, fan(A, false, 4)), 'a lower seq arriving late')
  t.alike(ix.fans(A).items, [{ key: B, seq: 5, at: at(5) }], 'it does not override')
  t.ok(add(ix, B, 5, fan(A, true, 5)), 'a re-add is a no-op')
  t.is(ix.stats().records, 4, 'every operation holds one slot, once')
  t.alike(ix.fans(B).items, [], 'the writer is not a fan of itself')
})

test('fans: a fan of the writer itself takes no slot and is never listed', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, A, 1, fan(A, true, 1)))
  t.alike(ix.fans(A).items, [])
  t.is(ix.stats().records, 0)
})

test('fans: a deletion falls back to the previous live operation; a tombstone first keeps the block out', (t) => {
  const ix = createEngagementIndex()
  add(ix, B, 1, fan(A, true, 1))
  add(ix, B, 2, fan(A, false, 2))
  t.alike(ix.fans(A).items, [])
  t.ok(ix.removeRecord(B, 2))
  t.alike(ix.fans(A).items, [{ key: B, seq: 1, at: at(1) }], 'the unfan was deleted: on again')
  t.ok(ix.removeRecord(B, 1))
  t.alike(ix.fans(A).items, [])
  t.is(ix.stats().records, 0, 'both slots were released')
  t.ok(add(ix, B, 1, fan(A, true, 1)), 'a tombstoned seq is not resurrected')
  t.alike(ix.fans(A).items, [])

  ix.removeRecord(C, 2)
  add(ix, C, 1, fan(A, true, 1))
  add(ix, C, 2, fan(A, false, 2))
  t.alike(keysOf(ix.fans(A)), [C], 'the deleted unfan never applied')
})

test('fans: newest first by at, ties by key; pages of FAN_PAGE with exclusive cursors and a total', (t) => {
  const ix = createEngagementIndex()
  const n = 2 * FAN_PAGE + 5
  for (let i = 1; i <= n; i++) add(ix, key(i), 1, fan(A, true, Math.floor(i / 2)))
  const seen = []
  let after = null
  let pages = 0
  for (;;) {
    const page = ix.fans(A, { after })
    pages++
    t.is(page.total, n)
    t.ok(page.items.length <= FAN_PAGE)
    seen.push(...page.items)
    if (page.next === null) break
    const last = page.items.at(-1)
    t.alike(page.next, { atMs: Date.parse(last.at), key: last.key }, 'next names the last row')
    after = page.next
  }
  t.is(pages, 3)
  t.is(seen.length, n)
  t.is(new Set(seen.map((r) => r.key)).size, n, 'no duplicates, no gaps')
  for (let i = 1; i < seen.length; i++) {
    const a = Date.parse(seen[i - 1].at)
    const b = Date.parse(seen[i].at)
    t.ok(a > b || (a === b && seen[i - 1].key < seen[i].key), 'ordered at ' + i)
  }
})

test('fans: a date before 1970 orders as 0 and its cursor still pages', (t) => {
  const ix = createEngagementIndex()
  add(ix, B, 1, fanRecord({ key: A, on: true, at: '1960-01-01T00:00:00.000Z' }))
  add(ix, C, 1, fan(A, true, 1))
  const page = ix.fans(A)
  t.alike(keysOf(page), [C, B])
  t.alike(ix.fans(A, { after: { atMs: 0, key: B } }).items, [], 'nothing after the last row')
  t.alike(keysOf(ix.fans(A, { after: { atMs: Date.parse(at(1)), key: C } })), [B])
})

test('fans: visible filters rows and counts, a throwing predicate hides only that row', (t) => {
  const ix = createEngagementIndex()
  add(ix, B, 1, fan(A, true, 1))
  add(ix, C, 1, fan(A, true, 2))
  const visible = (k) => {
    if (k === C) throw new Error('boom')
    return true
  }
  t.alike(keysOf(ix.fans(A, { visible })), [B])
  t.is(ix.fans(A, { visible }).total, 1)
  t.is(ix.fanCount(A, visible), 1)
  t.is(ix.fanCount(A, () => false), 0)
  t.is(ix.fanCount(A), 2)
})

test('fans: removeDiary of a fan takes its rows out, of the author keeps the rows of other diaries; clear empties', (t) => {
  const ix = createEngagementIndex()
  add(ix, B, 1, fan(A, true, 1))
  add(ix, B, 2, fan(C, true, 2))
  add(ix, C, 1, fan(A, true, 3))
  add(ix, A, 1, fan(B, true, 4))
  ix.removeDiary(B)
  t.alike(keysOf(ix.fans(A)), [C])
  t.alike(ix.fans(C).items, [])
  t.alike(keysOf(ix.fans(B)), [A], 'B\'s own fas live in other diaries')
  ix.removeDiary(A)
  t.alike(keysOf(ix.fans(B)), [], 'A was the only fan of B')
  t.is(ix.stats().records, 1)
  ix.clear()
  t.alike(ix.fans(A).items, [])
  t.is(ix.stats().records, 0)
})

test('fans: past FAN_KEYS_MAX distinct keys a new key is skipped without a slot, a known one still flips', (t) => {
  const ix = createEngagementIndex()
  let added = 0
  for (let i = 1; i <= FAN_KEYS_MAX; i++) if (add(ix, B, i, fan(key(i), true, 1))) added++
  t.is(added, FAN_KEYS_MAX)
  t.is(ix.stats().records, FAN_KEYS_MAX)
  t.ok(add(ix, B, FAN_KEYS_MAX + 1, fan(A, true, 2)), 'skipped, the cursor moves on')
  t.alike(ix.fans(A).items, [])
  t.is(ix.stats().records, FAN_KEYS_MAX, 'no slot taken')
  t.ok(add(ix, B, FAN_KEYS_MAX + 2, fan(key(1), false, 3)))
  t.alike(ix.fans(key(1)).items, [], 'a known key still flips')
  t.is(ix.stats().records, FAN_KEYS_MAX + 1)
})

test('fans: a record refused at the per-author cap pauses the cursor and lists nothing', (t) => {
  const ix = createEngagementIndex({ perAuthorMax: 1 })
  t.ok(add(ix, B, 1, fan(A, true, 1)))
  t.absent(add(ix, B, 2, fan(C, true, 2)), 'refused')
  t.alike(ix.fans(C).items, [])
  t.alike(keysOf(ix.fans(A)), [B])
})

test('fans: a malformed fan record is refused', (t) => {
  const ix = createEngagementIndex()
  t.absent(ix.add(B, 1, { type: 'fan', key: 'x', on: true, at: at(1) }))
  t.absent(ix.add(B, 1, { type: 'fan', key: A, on: 'yes', at: at(1) }))
  t.absent(ix.add(B, 1, { type: 'fan', key: A, on: true, at: 1 }))
  t.is(ix.stats().records, 0)
})
