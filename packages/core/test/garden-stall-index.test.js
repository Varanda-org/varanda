'use strict'

// The Barraquinha and Enfeites pointers of the seeder's engagement index
// (gardenStall()): the decor pointer, pending gifts and the Prateleira under
// the owner's on flag, takes, tombstones, every cap, the full mark, purge
// and the pending order. No network.
const test = require('brittle')
const { garden: G } = require('@varanda/rpc')
const {
  createEngagementIndex, GARDEN_GIFT_PAIR_MAX, GARDEN_GIFT_WRITER_MAX, GARDEN_GIFT_WRITERS_PER_OWNER, GARDEN_TAKES_MAX
} = require('../lib/engagement-index')
const {
  gardenRecord, gardenHelpRecord, gardenDecorRecord, gardenGiftRecord, gardenTakeRecord, validRecordCopy
} = require('../lib/records')

const O = 'f'.repeat(64)
const W = 'e'.repeat(64)
const HOUR = 3600000
const DAY = 86400000
// hh:00 Brasilia time (UTC-3) on 2026-03-<day>; 2026-03-14 is a Saturday.
const bra = (day, hh) => Date.parse('2026-03-' + String(day).padStart(2, '0') + 'T00:00:00.000Z') + 3 * HOUR + hh * HOUR
const SAT = 14
const NOW = bra(SAT, 12)
// The first instant the gifts of SAT stop being listable.
const CLOSES = bra(SAT + 7, 0)
const iso = (ms) => new Date(ms).toISOString()
const k = (i) => (i + 1).toString(16).padStart(64, '0')
const follows = () => 1
const open = { followSeq: follows }
const EMPTY = { decor: null, pending: [], shelf: [], hidden: false }

function add (ix, author, seq, record) {
  const copy = validRecordCopy(record, seq)
  if (copy === null) throw new Error('fixture record is invalid')
  return ix.add(author, seq, copy)
}

// The seeder's scan passes its clock (opts.now).
function addAt (ix, author, seq, record, now) {
  const copy = validRecordCopy(record, seq)
  if (copy === null) throw new Error('fixture record is invalid')
  return ix.add(author, seq, copy, { now })
}

// An on balcony for `owner`, at seq `seq` (1 by default, below every
// fixture take, decor and gift seq). It holds one record slot.
function openBalcony (ix, owner, seq = 1) {
  if (!add(ix, owner, seq, gardenRecord({ on: true, at: iso(NOW - DAY) }))) throw new Error('fixture balcony refused')
}

function gift (to, atMs = bra(SAT, 10)) {
  return gardenGiftRecord({ to, item: 'tomate', at: iso(atMs) })
}

function take (from, seq, atMs = NOW) {
  return gardenTakeRecord({ from, seq, at: iso(atMs) })
}

function pend (rows) {
  return rows.map((r) => r.author + ':' + r.seq)
}

test('gardenStall: null for a malformed owner or clock', (t) => {
  const ix = createEngagementIndex()
  for (const [owner, now] of [[null, NOW], ['x', NOW], [O.toUpperCase(), NOW], [O, NaN], [O, '1'], [O, Infinity]]) {
    t.is(ix.gardenStall(owner, now), null)
  }
  t.is(ix.gardenStall(O, NOW, null), null, 'null opts answer null, never throw')
})

test('gardenStall: an off or missing flag answers decor null and empty lists', (t) => {
  const ix = createEngagementIndex()
  t.alike(ix.gardenStall(O, NOW, open), EMPTY, 'no flag')
  t.ok(add(ix, O, 1, gardenRecord({ on: true, at: iso(NOW - DAY) })))
  t.ok(add(ix, O, 2, gardenDecorRecord({ items: ['rede'], at: iso(NOW - HOUR) })))
  t.ok(add(ix, W, 1, gift(O)))
  t.ok(add(ix, O, 3, take(W, 1)))
  const live = ix.gardenStall(O, NOW, open)
  t.is(live.decor, 2)
  t.alike(live.shelf, [{ seq: 3, from: W, gseq: 1 }])
  t.ok(add(ix, O, 4, gardenRecord({ on: false, at: iso(NOW) })))
  t.alike(ix.gardenStall(O, NOW, open), EMPTY, 'an off flag shows nothing')
  t.is(ix.stats().records, 5, 'every block holds one slot')
})

test('gardenStall: decor is latest wins, falls back on delete and is null at or below the on flag', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, O, 1, gardenDecorRecord({ items: ['rede'], at: iso(NOW - 3 * HOUR) })))
  openBalcony(ix, O, 2)
  t.is(ix.gardenStall(O, NOW, open).decor, null, 'a decor below the on flag is from an older join')
  t.ok(add(ix, O, 3, gardenDecorRecord({ items: ['rede', 'gato'], at: iso(NOW - 2 * HOUR) })))
  t.ok(add(ix, O, 4, gardenDecorRecord({ items: [], at: iso(NOW - HOUR) })))
  t.is(ix.gardenStall(O, NOW, open).decor, 4)
  t.ok(ix.removeRecord(O, 4))
  t.is(ix.gardenStall(O, NOW, open).decor, 3, 'a deletion falls back')
  t.ok(ix.removeRecord(O, 3))
  t.is(ix.gardenStall(O, NOW, open).decor, null, 'the fallback at or below the flag is null')
  t.ok(ix.removeRecord(O, 1))
  t.is(ix.stats().records, 1, 'only the flag is left')
  t.is(ix.profileExtra(O).garden, 2, 'profileExtra keeps its shape')
})

test('gardenStall: pending needs follow evidence and visibility; a take moves the gift to the shelf', (t) => {
  const ix = createEngagementIndex()
  const A = k(1)
  openBalcony(ix, O)
  t.ok(add(ix, A, 5, gift(O, bra(SAT, 9))))
  t.ok(add(ix, W, 7, gift(O, bra(SAT, 10))))
  t.alike(ix.gardenStall(O, NOW, { followSeq: (w) => (w === A ? 3 : 4) }).pending, [
    { author: W, seq: 7, followSeq: 4 },
    { author: A, seq: 5, followSeq: 3 }
  ], 'newest first')
  const none = ix.gardenStall(O, NOW)
  t.alike(none.pending, [], 'no followSeq: every writer omitted')
  t.is(none.hidden, false)
  t.alike(pend(ix.gardenStall(O, NOW, { followSeq: (w) => { if (w === A) throw new Error('x'); return 2 } }).pending), [W + ':7'])
  const hid = ix.gardenStall(O, NOW, { followSeq: follows, visible: (w) => w !== A })
  t.alike(pend(hid.pending), [W + ':7'])
  t.is(hid.hidden, true, 'a hidden writer with a listable row sets hidden')
  const thrown = ix.gardenStall(O, NOW, { followSeq: follows, visible: () => { throw new Error('x') } })
  t.alike(thrown.pending, [])
  t.is(thrown.hidden, true, 'a throwing visible hides the writer')
  t.ok(add(ix, O, 2, take(W, 7)))
  const after = ix.gardenStall(O, NOW, open)
  t.alike(pend(after.pending), [A + ':5'], 'a taken gift leaves pending')
  t.alike(after.shelf, [{ seq: 2, from: W, gseq: 7 }], 'and stands on the shelf')
  const noGiver = ix.gardenStall(O, NOW, { followSeq: follows, visible: (w) => w !== W })
  t.alike(noGiver.shelf, [], 'an invisible giver leaves the shelf')
  t.is(noGiver.hidden, true)
  t.alike(ix.gardenStall(O, CLOSES, open), EMPTY, 'neither list once the week ends')
  t.alike(ix.gardenStall(O, CLOSES - 1, open).shelf, [{ seq: 2, from: W, gseq: 7 }], 'both last to the end of the week')
})

test('gardenStall: one gift per writer per day, picked before taken gifts drop', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gift(O, bra(SAT, 11))))
  t.ok(add(ix, W, 2, gift(O, bra(SAT, 9))))
  t.ok(add(ix, W, 3, gift(O, bra(SAT - 7, 9))))
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'], 'the lowest seq of the day; last week is closed')
  t.ok(add(ix, O, 2, take(W, 1)))
  t.alike(ix.gardenStall(O, NOW, open).pending, [], 'taking the day pick never surfaces a second gift')
})

test('gardenStall: a shelf row needs its gift indexed, live, to the owner and listable', (t) => {
  const ix = createEngagementIndex()
  const A = k(1)
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gift(A)))
  t.ok(add(ix, W, 2, gift(O)))
  t.ok(add(ix, O, 2, take(W, 1)), 'a gift to someone else')
  t.ok(add(ix, O, 3, take(W, 9)), 'a gift never indexed')
  t.ok(add(ix, O, 4, take(A, 1)), 'a writer with no gifts')
  t.alike(ix.gardenStall(O, NOW, open).shelf, [])
  t.ok(add(ix, O, 5, take(W, 2)))
  t.ok(add(ix, O, 6, take(W, 2)))
  t.alike(ix.gardenStall(O, NOW, open).shelf, [{ seq: 6, from: W, gseq: 2 }, { seq: 5, from: W, gseq: 2 }], 'newest take first')
  t.alike(ix.gardenStall(A, NOW, open), EMPTY, 'the other addressee has no balcony')
})

test('gardenStall: a tombstoned gift leaves both lists', (t) => {
  const ix = createEngagementIndex()
  const A = k(1)
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gift(O)))
  t.ok(add(ix, A, 1, gift(O)))
  t.ok(add(ix, O, 2, take(W, 1)))
  t.is(ix.stats().records, 4)
  t.ok(ix.removeRecord(W, 1))
  t.ok(ix.removeRecord(A, 1))
  t.alike(ix.gardenStall(O, NOW, open), { decor: null, pending: [], shelf: [], hidden: false })
  t.is(ix.stats().records, 2, 'both gift slots freed')
  t.ok(add(ix, W, 1, gift(O)), 'a tombstoned gift is not resurrected')
  t.alike(ix.gardenStall(O, NOW, open).shelf, [])
})

test('gardenStall: a tombstoned take returns its gift to pending while the week lasts', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gift(O)))
  t.ok(add(ix, O, 2, take(W, 1)))
  t.alike(ix.gardenStall(O, NOW, open).pending, [])
  t.ok(ix.removeRecord(O, 2))
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'], 'pending again')
  t.alike(ix.gardenStall(O, NOW, open).shelf, [])
  t.alike(ix.gardenStall(O, CLOSES, open).pending, [], 'not after the week')
  t.is(ix.stats().records, 2, 'the take slot is freed')
  t.ok(add(ix, O, 2, take(W, 1)), 'a tombstoned take is not resurrected')
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'])
})

test('gardenStall: a take at or below the on flag is not on the shelf and hides no gift', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, W, 1, gift(O)))
  t.ok(add(ix, O, 1, gardenRecord({ on: true, at: iso(NOW - 2 * DAY) })))
  t.ok(add(ix, O, 2, take(W, 1)))
  t.ok(add(ix, O, 3, gardenRecord({ on: true, at: iso(NOW - DAY) })))
  const out = ix.gardenStall(O, NOW, open)
  t.alike(out.shelf, [], 'an older join is not on the shelf')
  t.alike(pend(out.pending), [W + ':1'], 'and does not hide its gift')
})

test('gardenStall: non-Saturday and self blocks take no slot and return true', (t) => {
  const ix = createEngagementIndex({ maxRecords: 0 })
  t.ok(add(ix, W, 1, gift(O, bra(SAT - 1, 23))), 'a Friday gift')
  t.ok(add(ix, W, 2, gift(O, bra(SAT + 1, 0))), 'a Sunday gift')
  t.ok(add(ix, W, 3, gift(W)), 'a gift to its own writer')
  t.ok(add(ix, W, 4, take(W, 1)), 'a take naming its own writer')
  t.is(ix.stats().records, 0, 'no slot')
  t.is(add(ix, W, 5, gift(O)), false, 'while a real gift pauses at the cap')
  t.is(add(ix, O, 1, take(W, 1)), false, 'and so does a real take')
  t.is(add(ix, O, 2, gardenDecorRecord({ items: ['pisca'], at: iso(NOW) })), false, 'and a decor')
  const roomy = createEngagementIndex()
  openBalcony(roomy, O)
  t.ok(add(roomy, W, 1, gift(O, bra(SAT - 1, 12))))
  t.alike(roomy.gardenStall(O, NOW, open).pending, [], 'never listed')
})

test('gardenStall: shape guards refuse malformed copies, and every valid shape returns true', (t) => {
  const ix = createEngagementIndex()
  const at = iso(bra(SAT, 10))
  t.is(ix.add(W, 1, { type: 'garden-decor', items: 'rede', at }), false)
  t.is(ix.add(W, 1, { type: 'garden-gift', to: 'x', item: 'tomate', at }), false)
  t.is(ix.add(W, 1, { type: 'garden-gift', to: O, item: 'tomate', at: 'nope' }), false)
  t.is(ix.add(W, 1, { type: 'garden-take', from: O.toUpperCase(), seq: 1, at }), false)
  t.is(ix.add(W, 1, { type: 'garden-take', from: O, seq: 0, at }), false)
  t.is(ix.stats().records, 0)
  let seq = 1
  for (const items of [[], ['rede'], ['rede', 'varal', 'gato', 'pisca']]) {
    t.ok(add(ix, W, seq++, gardenDecorRecord({ items, at })))
  }
  for (const item of G.GARDEN_PLANTS.map((p) => p.id)) {
    t.ok(add(ix, W, seq++, gardenGiftRecord({ to: k(seq), item, at })))
  }
  t.ok(add(ix, W, seq++, gardenGiftRecord({ to: O, item: 'tomate', at: '1969-12-27T12:00:00.000Z' })), 'a Saturday before the epoch')
  t.ok(add(ix, W, seq++, take(O, Number.MAX_SAFE_INTEGER)))
})

test('gardenStall: the duplicate-seq guard ignores a replay', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gift(O)))
  t.ok(add(ix, W, 1, gift(O, bra(SAT, 11))))
  t.ok(add(ix, O, 2, take(W, 1)))
  t.ok(add(ix, O, 2, take(W, 1)))
  t.ok(add(ix, O, 3, gardenDecorRecord({ items: ['rede'], at: iso(NOW) })))
  t.ok(add(ix, O, 3, gardenDecorRecord({ items: ['gato'], at: iso(NOW) })))
  t.ok(add(ix, O, 2, gardenDecorRecord({ items: ['gato'], at: iso(NOW) })), 'a decor replayed over a take seq')
  t.is(ix.stats().records, 4, 'each seq holds one slot')
  t.is(ix.gardenStall(O, NOW, open).decor, 3)
  t.ok(add(ix, W, 1, gardenDecorRecord({ items: ['rede'], at: iso(NOW) })), 'another type replayed over a gift seq')
  t.is(ix.stats().records, 4)
})

test('gardenStall: the pair cap never evicts the day pick: a same-day duplicate is skipped without a slot', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let s = 1; s <= GARDEN_GIFT_PAIR_MAX; s++) t.ok(add(ix, W, s, gift(O, bra(SAT, 23 - s))))
  t.is(ix.stats().records, 1 + GARDEN_GIFT_PAIR_MAX)
  t.ok(add(ix, W, GARDEN_GIFT_PAIR_MAX + 1, gift(O, bra(SAT, 1))))
  t.is(ix.stats().records, 1 + GARDEN_GIFT_PAIR_MAX, 'no slot')
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'], 'seq 1 is still the day pick')
  t.ok(add(ix, O, 2, take(W, 1)))
  t.alike(ix.gardenStall(O, NOW, open).shelf, [{ seq: 2, from: W, gseq: 1 }], 'the pick is still indexed')
  // Out of order: the lower seq becomes the day pick, the highest duplicate leaves.
  const ooo = createEngagementIndex()
  for (let s = 2; s <= GARDEN_GIFT_PAIR_MAX + 1; s++) t.ok(add(ooo, W, s, gift(O)))
  t.ok(add(ooo, W, 1, gift(O)))
  t.is(ooo.stats().records, GARDEN_GIFT_PAIR_MAX)
  openBalcony(ooo, O)
  t.alike(pend(ooo.gardenStall(O, NOW, open).pending), [W + ':1'])
})

test('gardenStall: the writer cap evicts the lowest seq and frees the record budget', (t) => {
  const max = 1 + GARDEN_GIFT_WRITER_MAX
  const ix = createEngagementIndex({ maxRecords: max, perAuthorMax: GARDEN_GIFT_WRITER_MAX })
  openBalcony(ix, O)
  for (let s = 1; s <= GARDEN_GIFT_WRITER_MAX; s++) t.ok(add(ix, W, s, gift(s === 1 ? O : k(s))))
  t.is(ix.stats().records, max, 'both caps reached')
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'])
  t.ok(add(ix, W, GARDEN_GIFT_WRITER_MAX + 1, gift(k(1000))), 'admitted at both caps: the eviction makes room')
  t.is(ix.stats().records, max)
  t.alike(ix.gardenStall(O, NOW, open).pending, [], 'seq 1 left')
  t.is(add(ix, O, 2, take(W, 2)), false, 'the global budget is still full for another writer')
  t.ok(ix.removeRecord(W, 2))
  t.ok(add(ix, O, 2, take(W, 3)), 'a deleted gift frees its slot')
})

test('gardenStall: the takes cap keeps 54 live takes, a 55th that would bring one back is skipped', (t) => {
  t.is(GARDEN_TAKES_MAX, G.GARDEN_TAKE_ROWS)
  t.is(GARDEN_TAKES_MAX, 54)
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i <= GARDEN_TAKES_MAX; i++) t.ok(add(ix, k(i), 1, gift(O, bra(SAT, 10) + i)))
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, O, 2 + i, take(k(i), 1)))
  const full = ix.gardenStall(O, NOW, open)
  t.alike(pend(full.pending), [k(GARDEN_TAKES_MAX) + ':1'], 'every taken gift is hidden from pending')
  t.is(full.shelf.length, G.GARDEN_SHELF_ROWS)
  t.is(full.shelf[0].seq, 1 + GARDEN_TAKES_MAX, 'newest take first')
  t.is(full.hidden, true, 'the shelf was cut')
  const before = ix.stats().records
  t.ok(add(ix, O, 2 + GARDEN_TAKES_MAX, take(k(GARDEN_TAKES_MAX), 1)), 'skipped, never paused')
  t.is(ix.stats().records, before, 'no slot')
  const after = ix.gardenStall(O, NOW, open)
  t.alike(pend(after.pending), [k(GARDEN_TAKES_MAX) + ':1'], 'no taken gift is pending again')
  t.is(after.hidden, true)
})

test('gardenStall: past the writers cap a gift takes no slot and the addressee says hidden', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i < GARDEN_GIFT_WRITERS_PER_OWNER; i++) t.ok(add(ix, k(i), 1, gift(O)))
  const before = ix.stats().records
  t.is(ix.gardenStall(O, NOW, open).hidden, true, 'the 12-row cut already hides')
  t.ok(add(ix, W, 1, gift(O, bra(SAT, 3))), 'skipped, never paused')
  t.is(ix.stats().records, before, 'no slot')
  // No followSeq: every writer is omitted without hiding and no list is
  // cut, so only the full mark can say hidden.
  t.is(ix.gardenStall(O, NOW).hidden, true, 'the full mark hides')
  t.is(ix.gardenStall(O, CLOSES - 1).hidden, true, 'until the refused gift week ends')
  t.is(ix.gardenStall(O, CLOSES).hidden, false)
  t.ok(add(ix, k(0), 2, gift(O)), 'a writer already counted keeps its place')
  t.is(ix.stats().records, before + 1)
})

test('gardenStall: with the clock, a new giver takes the place of a writer with nothing listable', (t) => {
  let freed = 0
  const ix = createEngagementIndex({ onFreed: () => { freed++ } })
  openBalcony(ix, O)
  const lastWeek = bra(SAT - 7, 10)
  for (let i = 0; i < GARDEN_GIFT_WRITERS_PER_OWNER; i++) {
    t.ok(addAt(ix, k(i), 1, gift(O, lastWeek + i), NOW))
    t.ok(addAt(ix, k(i), 2, gift(O, lastWeek + i + 1), NOW))
  }
  const before = ix.stats().records
  t.is(before, 1 + 2 * GARDEN_GIFT_WRITERS_PER_OWNER)
  t.ok(addAt(ix, W, 1, gift(O), NOW))
  t.is(ix.stats().records, before - 1, 'the stale writer oldest by its newest gift left with both rows, the new gift took one slot')
  t.is(freed, 1, 'the freed slots are announced')
  const out = ix.gardenStall(O, NOW, open)
  t.alike(pend(out.pending), [W + ':1'], 'the new giver is pending')
  t.is(out.hidden, false, 'no full mark')
  t.ok(addAt(ix, k(1), 3, gift(k(5000)), NOW))
  t.ok(addAt(ix, k(0), 3, gift(O), NOW), 'the evicted writer is a new writer again and takes the next stale place')
  t.alike(pend(ix.gardenStall(O, NOW, open).pending).sort(), [W + ':1', k(0) + ':3'].sort())
})

test('gardenStall: with the clock, a gift it cannot list costs no place and no full mark', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i < GARDEN_GIFT_WRITERS_PER_OWNER; i++) t.ok(addAt(ix, k(i), 1, gift(O), NOW))
  const before = ix.stats().records
  t.ok(addAt(ix, W, 1, gift(O, bra(SAT + 7, 10)), NOW), 'next Saturday, too far ahead to list')
  t.is(ix.stats().records, before, 'no slot')
  // No followSeq: every writer is omitted without hiding and no list is
  // cut, so only a full mark could say hidden.
  t.is(ix.gardenStall(O, NOW).hidden, false)
  t.is(ix.gardenStall(O, bra(SAT + 7, 12)).hidden, false, 'not even once that date is listable')
})

test('gardenStall: a refused future-Saturday gift says hidden only while it would be listable', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i < GARDEN_GIFT_WRITERS_PER_OWNER; i++) t.ok(addAt(ix, k(i), 1, gift(O), NOW))
  const friday = bra(SAT + 6, 12)
  const before = ix.stats().records
  t.ok(addAt(ix, W, 1, gift(O, bra(SAT + 7, 10)), friday), 'listable on Friday, but every place holds a listable gift')
  t.is(ix.stats().records, before, 'no slot')
  t.is(ix.gardenStall(O, bra(SAT + 5, 12)).hidden, false, 'before the refused gift is listable')
  t.is(ix.gardenStall(O, friday).hidden, true, 'inside its window')
  t.is(ix.gardenStall(O, bra(SAT + 7, 12)).hidden, true)
  t.is(ix.gardenStall(O, bra(SAT + 14, 0) - 1).hidden, true, 'to the end of its week')
  t.is(ix.gardenStall(O, bra(SAT + 14, 0)).hidden, false)
})

test('gardenStall: removeDiary of the addressee keeps gift rows, of the writer drops them', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gift(O)))
  t.ok(add(ix, k(1), 1, gift(O)))
  t.ok(add(ix, O, 2, take(W, 1)))
  t.ok(ix.removeDiary(O))
  t.is(ix.stats().records, 2, 'the owner flag and take left with its diary')
  openBalcony(ix, O)
  t.alike(pend(ix.gardenStall(O, NOW, open).pending).sort(), [W + ':1', k(1) + ':1'].sort(), 'gift rows kept')
  t.ok(add(ix, O, 2, take(W, 1)))
  t.ok(ix.removeDiary(W))
  const out = ix.gardenStall(O, NOW, open)
  t.alike(pend(out.pending), [k(1) + ':1'])
  t.alike(out.shelf, [], 'a take whose giver diary left is off the shelf')
})

test('gardenStall: clear() drops the gift rows and the full mark', (t) => {
  const ix = createEngagementIndex()
  for (let i = 0; i <= GARDEN_GIFT_WRITERS_PER_OWNER; i++) t.ok(add(ix, k(i), 1, gift(O)))
  ix.clear()
  openBalcony(ix, O)
  t.alike(ix.gardenStall(O, NOW, open), EMPTY)
  t.is(ix.stats().records, 1)
  t.ok(add(ix, W, 1, gift(O)))
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'])
})

test('gardenStall: a gift flood leaves the help rows intact', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, W, 1, gardenHelpRecord({ to: O, pot: 0, at: iso(NOW - HOUR) })))
  for (let i = 0; i < GARDEN_GIFT_WRITERS_PER_OWNER + 10; i++) {
    for (let s = 1; s <= GARDEN_GIFT_PAIR_MAX + 1; s++) t.ok(add(ix, k(i), s, gift(O)))
  }
  for (let s = 2; s < 2 + GARDEN_GIFT_WRITER_MAX + 5; s++) t.ok(add(ix, W, s, gift(s === 2 ? O : k(1000 + s))))
  const g = ix.garden(O, NOW, open)
  t.alike(g.helps, [{ author: W, seq: 1, followSeq: 1 }])
  t.is(g.hidden, false, 'the gift full mark is not the help one')
})

test('gardenStall: rows dated after now never push out a row at or before now', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const early = k(100)
  t.ok(add(ix, early, 1, gift(O, bra(SAT, 8))))
  for (let i = 0; i < G.GARDEN_GIFT_ROWS; i++) t.ok(add(ix, k(i), 1, gift(O, bra(SAT, 20) + i)))
  const out = ix.gardenStall(O, NOW, open)
  t.is(out.pending.length, G.GARDEN_GIFT_ROWS)
  t.is(out.pending[0].author, early, 'the row at or before now comes first')
  t.alike(out.pending.slice(1).map((r) => r.author), Array.from({ length: G.GARDEN_GIFT_ROWS - 1 }, (_, i) => k(i)), 'then future rows, nearest first')
  t.is(out.hidden, true, 'the cut says hidden')
})

test('gardenStall: followed givers rank before every other giver', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const friend = k(500)
  const lastMs = bra(SAT + 1, 0) - 1
  t.ok(G.stallDay(lastMs))
  for (let i = 0; i < G.GARDEN_GIFT_ROWS; i++) t.ok(add(ix, k(i), 1, gift(O, lastMs)))
  t.ok(add(ix, friend, 1, gift(O, bra(SAT, 9))))
  const tuesday = bra(SAT + 3, 12)
  const out = ix.gardenStall(O, tuesday, { followSeq: follows, followed: (w) => w === friend })
  t.is(out.pending.length, G.GARDEN_GIFT_ROWS)
  t.is(out.pending[0].author, friend, 'the followed giver is first')
  const plain = ix.gardenStall(O, tuesday, open)
  t.absent(plain.pending.some((r) => r.author === friend), 'without followed the later dates fill the cut')
  const thrown = ix.gardenStall(O, tuesday, { followSeq: follows, followed: () => { throw new Error('x') } })
  t.alike(thrown.pending, plain.pending, 'a throwing followed reads false')
  const truthy = ix.gardenStall(O, tuesday, { followSeq: follows, followed: () => 1 })
  t.alike(truthy.pending, plain.pending, 'a non-true answer reads false')
})

// The seeder passes its clock and the follow rank of each giver (opts.giftRank).
function addRanked (ix, author, seq, record, now, giftRank) {
  const copy = validRecordCopy(record, seq)
  if (copy === null) throw new Error('fixture record is invalid')
  return ix.add(author, seq, copy, { now, giftRank })
}

// GARDEN_GIFT_WRITERS_PER_OWNER givers k(0), k(1)... each with one listable
// gift to O, ranked by `rank`.
function fillStall (ix, rank, at = bra(SAT, 10)) {
  for (let i = 0; i < GARDEN_GIFT_WRITERS_PER_OWNER; i++) {
    if (!addRanked(ix, k(i), 1, gift(O, at), NOW, rank)) throw new Error('fixture gift refused')
  }
}

const only = (who, n = 3) => ({ followSeq: (w) => (w === who ? n : null) })

test('gardenStall: at the writers cap a follower takes the place of a giver who follows no one', (t) => {
  let freed = 0
  const ix = createEngagementIndex({ onFreed: () => { freed++ } })
  openBalcony(ix, O)
  const rank = (w) => (w === W ? 1 : 0)
  fillStall(ix, rank)
  t.alike(pend(ix.gardenStall(O, NOW, only(k(0))).pending), [k(0) + ':1'], 'k(0) holds a place')
  const before = ix.stats().records
  t.ok(addRanked(ix, W, 1, gift(O, bra(SAT, 11)), NOW, rank))
  t.is(ix.stats().records, before, 'one stranger gift left, the follower gift took its slot')
  t.is(freed, 1, 'the freed slot is announced')
  const out = ix.gardenStall(O, NOW, only(W))
  t.alike(pend(out.pending), [W + ':1'], 'the follower is pending')
  t.is(out.hidden, true, 'its follow may be indexed later: the evicted listable gift marks the owner full')
  t.is(ix.gardenStall(O, CLOSES - 1, only(W)).hidden, true, 'while the evicted gift would be listable')
  t.is(ix.gardenStall(O, CLOSES, only(W)).hidden, false)
  t.alike(ix.gardenStall(O, NOW, only(k(0))).pending, [], 'the lowest key of the tied strangers left')
})

test('gardenStall: a follower whose rank reads 0 for a moment is evicted and the owner says hidden', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  // k(0) follows O, but its follows are pending a rescan: the rank reads 0.
  const rank = (w) => (w === k(0) ? 0 : 1)
  fillStall(ix, () => 1)
  t.ok(addRanked(ix, W, 1, gift(O, bra(SAT, 11)), NOW, rank))
  t.alike(ix.gardenStall(O, NOW, only(k(0))).pending, [], 'k(0) left')
  const out = ix.gardenStall(O, NOW, only(W))
  t.alike(pend(out.pending), [W + ':1'])
  t.is(out.hidden, true, 'the lost follower gift is not silent')
})

test('gardenStall: at the writers cap a giver the owner follows takes the place of a follower', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const rank = (w) => (w === W ? 2 : 1)
  fillStall(ix, rank)
  const before = ix.stats().records
  t.ok(addRanked(ix, W, 1, gift(O, bra(SAT, 11)), NOW, rank))
  t.is(ix.stats().records, before)
  const out = ix.gardenStall(O, NOW, { ...only(W), followed: (w) => w === W })
  t.alike(pend(out.pending), [W + ':1'], 'the owner\'s friend is pending')
  t.is(out.hidden, true, 'the evicted follower\'s gift was listable: the stall says so')
  t.is(ix.gardenStall(O, CLOSES - 1, only(W)).hidden, true, 'while that gift would be listable')
  t.is(ix.gardenStall(O, CLOSES, only(W)).hidden, false)
  t.alike(ix.gardenStall(O, NOW, only(k(0))).pending, [], 'k(0) left')
})

test('gardenStall: at the writers cap a follower never takes the place of another follower', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  fillStall(ix, () => 1)
  const before = ix.stats().records
  t.ok(addRanked(ix, W, 1, gift(O, bra(SAT, 11)), NOW, () => 1), 'skipped, never paused')
  t.is(ix.stats().records, before, 'no slot')
  const out = ix.gardenStall(O, NOW, only(W))
  t.alike(out.pending, [], 'not listed')
  t.is(out.hidden, true, 'the refused gift says hidden')
})

test('gardenStall: at the writers cap a giver who follows no one is refused and marked full', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  fillStall(ix, (w) => (w === W ? 0 : 2))
  const before = ix.stats().records
  t.ok(addRanked(ix, W, 1, gift(O, bra(SAT, 11)), NOW, (w) => (w === W ? 0 : 2)))
  t.is(ix.stats().records, before, 'no slot')
  t.is(ix.gardenStall(O, NOW).hidden, true, 'its follow may be indexed later: the full mark hides')
  t.is(ix.gardenStall(O, CLOSES).hidden, false, 'until its week ends')
})

test('gardenStall: a rank tie at the writers cap goes to the giver whose newest gift is the oldest, then the lower key', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const strangers = new Set([k(0), k(1)])
  const rank = (w) => (strangers.has(w) ? 0 : 1)
  // k(0) holds the oldest gift of the two but also the newest one.
  t.ok(addRanked(ix, k(0), 1, gift(O, bra(SAT, 7)), NOW, rank))
  t.ok(addRanked(ix, k(0), 2, gift(O, bra(SAT, 11)), NOW, rank))
  t.ok(addRanked(ix, k(1), 1, gift(O, bra(SAT, 9)), NOW, rank))
  for (let i = 2; i < GARDEN_GIFT_WRITERS_PER_OWNER; i++) t.ok(addRanked(ix, k(i), 1, gift(O), NOW, rank))
  t.ok(addRanked(ix, W, 1, gift(O), NOW, rank))
  t.alike(ix.gardenStall(O, NOW, only(k(1))).pending, [], 'k(1) left: its newest gift is older than k(0)\'s')
  t.alike(pend(ix.gardenStall(O, NOW, only(k(0))).pending), [k(0) + ':1'], 'k(0) stays')
  const B = k(900)
  t.ok(addRanked(ix, B, 1, gift(O), NOW, rank))
  t.alike(ix.gardenStall(O, NOW, only(k(0))).pending, [], 'then the last stranger')
  const C = k(901)
  t.ok(addRanked(ix, C, 1, gift(O), NOW, rank))
  t.alike(ix.gardenStall(O, NOW, only(C)).pending, [], 'no stranger left: refused')
  t.is(ix.gardenStall(O, NOW).hidden, true)
})

test('gardenStall: a giftRank that throws or answers anything but 0, 1 or 2 counts as 0 and never throws', (t) => {
  const thrower = createEngagementIndex()
  openBalcony(thrower, O)
  const held = (w) => { if (w !== W) throw new Error('x'); return 1 }
  fillStall(thrower, () => 0)
  t.is(addRanked(thrower, W, 1, gift(O), NOW, held), true, 'held givers whose rank throws are 0')
  t.alike(pend(thrower.gardenStall(O, NOW, only(W)).pending), [W + ':1'])
  for (const bad of [() => { throw new Error('x') }, () => 7, () => NaN, () => '2', () => true, () => -1, 'nope']) {
    const ix = createEngagementIndex()
    openBalcony(ix, O)
    fillStall(ix, () => 0)
    const giftRank = typeof bad === 'function' ? (w) => (w === W ? bad() : 0) : bad
    const before = ix.stats().records
    t.is(addRanked(ix, W, 1, gift(O), NOW, giftRank), true, 'skipped, never paused or thrown')
    t.is(ix.stats().records, before, 'no slot')
    t.alike(ix.gardenStall(O, NOW, only(W)).pending, [])
    t.is(ix.gardenStall(O, NOW).hidden, true)
  }
})

test('gardenStall: a rank eviction frees every slot of the evicted giver to that owner', (t) => {
  const ix = createEngagementIndex({ perAuthorMax: 3 })
  openBalcony(ix, O)
  const rank = (w) => (w === W ? 1 : 0)
  fillStall(ix, rank)
  t.ok(addRanked(ix, k(0), 2, gift(O, bra(SAT, 9)), NOW, rank))
  t.ok(addRanked(ix, k(0), 3, gift(k(800)), NOW, rank))
  t.is(add(ix, k(0), 4, gardenDecorRecord({ items: ['rede'], at: iso(NOW) })), false, 'k(0) is at its author cap')
  const before = ix.stats().records
  t.ok(addRanked(ix, W, 1, gift(O, bra(SAT, 8)), NOW, rank))
  t.is(ix.stats().records, before - 1, 'both gifts of k(0) to O left, the new gift took one slot')
  t.ok(add(ix, k(0), 4, gardenDecorRecord({ items: ['rede'], at: iso(NOW) })))
  t.ok(add(ix, k(0), 5, gardenDecorRecord({ items: ['gato'], at: iso(NOW) })), 'k(0) has two slots back')
  t.is(add(ix, k(0), 6, gardenDecorRecord({ items: ['pisca'], at: iso(NOW) })), false, 'and only two: its gift to another owner stays')
  t.is(ix.stats().records, before + 1)
})

test('gardenStall: a same-day duplicate never evicts an accepted pick at the pair cap', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(addAt(ix, W, 1, gift(O, bra(SAT, 9)), NOW))
  t.ok(add(ix, O, 2, take(W, 1)))
  for (let s = 2; s <= GARDEN_GIFT_PAIR_MAX + 1; s++) t.ok(addAt(ix, W, s, gift(O, bra(SAT, 10)), NOW))
  const out = ix.gardenStall(O, NOW, open)
  t.alike(out.pending, [], 'taking the day pick still surfaces no other gift')
  t.alike(out.shelf, [{ seq: 2, from: W, gseq: 1 }], 'the take stays on the shelf')
  t.is(out.hidden, false, 'a duplicate the fold drops is no reason to hide')
  t.is(ix.stats().records, 2 + GARDEN_GIFT_PAIR_MAX)
})

test('gardenStall: the writer cap never evicts a day pick while a duplicate can go', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(addAt(ix, W, 1, gift(O, bra(SAT, 9)), NOW))
  t.ok(add(ix, O, 2, take(W, 1)))
  for (let s = 2; s <= GARDEN_GIFT_WRITER_MAX; s++) t.ok(addAt(ix, W, s, gift(k(s)), NOW))
  const before = ix.stats().records
  t.ok(addAt(ix, W, GARDEN_GIFT_WRITER_MAX + 1, gift(O, bra(SAT, 10)), NOW), 'a second gift to O that day')
  t.is(ix.stats().records, before, 'skipped without a slot')
  const out = ix.gardenStall(O, NOW, open)
  t.alike(out.pending, [], 'the taken pick keeps the day')
  t.alike(out.shelf, [{ seq: 2, from: W, gseq: 1 }])
  t.is(out.hidden, false)
  // A kept duplicate leaves before any pick: W gives O another gift that
  // day below a full list, then a new addressee comes.
  const dup = createEngagementIndex()
  openBalcony(dup, O)
  t.ok(addAt(dup, W, 1, gift(O, bra(SAT, 9)), NOW))
  t.ok(addAt(dup, W, 2, gift(O, bra(SAT, 10)), NOW))
  t.ok(add(dup, O, 2, take(W, 1)))
  for (let s = 3; s <= GARDEN_GIFT_WRITER_MAX; s++) t.ok(addAt(dup, W, s, gift(k(s)), NOW))
  t.ok(addAt(dup, W, GARDEN_GIFT_WRITER_MAX + 1, gift(k(1000)), NOW))
  t.ok(add(dup, k(1000), 1, gardenRecord({ on: true, at: iso(NOW - DAY) })))
  t.alike(pend(dup.gardenStall(k(1000), NOW, open).pending), [W + ':' + (GARDEN_GIFT_WRITER_MAX + 1)], 'the new gift is kept')
  t.alike(dup.gardenStall(O, NOW, open).pending, [], 'the duplicate of O left, not the pick')
  t.alike(dup.gardenStall(O, NOW, open).shelf, [{ seq: 2, from: W, gseq: 1 }])
})

test('gardenStall: at the pair cap a row dead at the clock leaves before a live one', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(addAt(ix, W, 1, gift(O, bra(SAT, 9)), NOW))
  t.ok(addAt(ix, W, 2, gift(O, bra(SAT - 7, 9)), NOW), 'last week: closed at NOW')
  t.ok(addAt(ix, W, 3, gift(O, bra(SAT, 10)), NOW))
  t.ok(addAt(ix, W, 4, gift(O, bra(SAT, 11)), NOW))
  t.ok(addAt(ix, W, 5, gift(O, bra(SAT, 11)), NOW))
  t.is(ix.stats().records, 1 + GARDEN_GIFT_PAIR_MAX, 'one row left')
  t.alike(pend(ix.gardenStall(O, NOW, open).pending), [W + ':1'], 'the day pick stays')
  t.ok(add(ix, O, 2, take(W, 5)))
  t.ok(add(ix, O, 3, take(W, 2)))
  t.alike(ix.gardenStall(O, NOW, open).shelf, [{ seq: 2, from: W, gseq: 5 }], 'seq 5 is kept: the dead seq 2 left, not a live duplicate')
})

test('gardenStall: the takes cap evicts a take whose gift is closed first; with none, the take is skipped and hidden', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const D = 20
  for (let i = 0; i <= GARDEN_TAKES_MAX; i++) t.ok(add(ix, k(i), 1, gift(O, i === D ? bra(SAT - 7, 10) : bra(SAT, 10) + i)))
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, O, 2 + i, take(k(i), 1)))
  const before = ix.stats().records
  t.ok(addAt(ix, O, 2 + GARDEN_TAKES_MAX, take(k(GARDEN_TAKES_MAX), 1), NOW))
  t.is(ix.stats().records, before, 'net zero')
  t.alike(ix.gardenStall(O, NOW, open).pending, [], 'the closed take left: no taken gift is pending again')
  // Next Saturday: the 54 takes of this week still hide listable gifts on
  // Friday, so a take of next week's gift is skipped and says hidden.
  const next = createEngagementIndex()
  openBalcony(next, O)
  const N = k(GARDEN_TAKES_MAX)
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(next, k(i), 1, gift(O, bra(SAT, 10) + i)))
  t.ok(add(next, N, 1, gift(O, bra(SAT + 7, 10))))
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(next, O, 2 + i, take(k(i), 1)))
  const friday = bra(SAT + 6, 12)
  const full = next.stats().records
  t.ok(addAt(next, O, 2 + GARDEN_TAKES_MAX, take(N, 1, friday), friday), 'skipped, never paused')
  t.is(next.stats().records, full, 'no slot')
  const sat = bra(SAT + 7, 12)
  const out = next.gardenStall(O, sat, open)
  t.alike(pend(out.pending), [N + ':1'], 'the gift of the skipped take is still pending')
  t.alike(out.shelf, [], 'this week\'s takes closed')
  t.is(out.hidden, true, 'the skipped take says hidden')
  t.is(next.gardenStall(O, bra(SAT + 14, 0) - 1, open).hidden, true, 'while its gift is listable')
  t.is(next.gardenStall(O, bra(SAT + 14, 0), open).hidden, false)
})

test('gardenStall: a take the takes cap skips before its gift is indexed hides that gift once indexed', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const N = k(900)
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, k(i), 1, gift(O, bra(SAT, 10) + i)))
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, O, 2 + i, take(k(i), 1)))
  const friday = bra(SAT + 6, 12)
  const before = ix.stats().records
  t.ok(addAt(ix, O, 2 + GARDEN_TAKES_MAX, take(N, 1, friday), friday), 'its gift is not indexed yet: skipped')
  t.is(ix.stats().records, before, 'no slot')
  t.ok(add(ix, N, 1, gift(O, bra(SAT + 7, 10))), 'the gift comes later')
  const sat = bra(SAT + 7, 12)
  const out = ix.gardenStall(O, sat, open)
  t.alike(pend(out.pending), [N + ':1'], 'the taken gift shows as pending')
  t.alike(out.shelf, [], 'this week\'s takes closed')
  t.is(out.hidden, true, 'and the skipped take says hidden')
  t.is(ix.gardenStall(O, bra(SAT + 14, 0) - 1, open).hidden, true, 'while that gift would be listable')
  t.is(ix.gardenStall(O, bra(SAT + 14, 0), open).hidden, false)
})

test('gardenStall: a take the takes cap skips whose gift is closed for good, or to someone else, leaves no mark', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const D = k(900)
  const X = k(901)
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, k(i), 1, gift(O, bra(SAT, 10) + i)))
  t.ok(add(ix, D, 1, gift(O, bra(SAT - 7, 10))))
  t.ok(add(ix, X, 1, gift(k(902))))
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, O, 2 + i, take(k(i), 1)))
  const friday = bra(SAT + 6, 12)
  const before = ix.stats().records
  t.ok(addAt(ix, O, 2 + GARDEN_TAKES_MAX, take(D, 1, friday), friday), 'last week\'s gift: skipped')
  t.ok(addAt(ix, O, 3 + GARDEN_TAKES_MAX, take(X, 1, friday), friday), 'a gift to someone else: skipped')
  t.is(ix.stats().records, before, 'no slot')
  t.is(ix.gardenStall(O, bra(SAT + 7, 12), open).hidden, false, 'nothing can come back: no mark')
})

test('gardenStall: a take the takes cap evicts before its gift is indexed marks the owner full', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const N = k(900)
  const friday = bra(SAT + 6, 12)
  for (let i = 0; i < GARDEN_TAKES_MAX; i++) t.ok(add(ix, k(i), 1, gift(O, bra(SAT, 10) + i)))
  for (let i = 0; i < GARDEN_TAKES_MAX - 1; i++) t.ok(add(ix, O, 2 + i, take(k(i), 1)))
  t.ok(add(ix, O, 1 + GARDEN_TAKES_MAX, take(N, 1, friday)), 'a take of a gift not indexed yet')
  const before = ix.stats().records
  t.ok(addAt(ix, O, 2 + GARDEN_TAKES_MAX, take(k(GARDEN_TAKES_MAX - 1), 1, friday), friday))
  t.is(ix.stats().records, before, 'net zero: the take of the unknown gift left')
  t.ok(add(ix, N, 1, gift(O, bra(SAT + 7, 10))))
  const out = ix.gardenStall(O, bra(SAT + 7, 12), open)
  t.alike(pend(out.pending), [N + ':1'])
  t.is(out.hidden, true, 'the evicted take says hidden')
})

test('gardenStall: the writer cap evicting a listable day pick marks its addressee full', (t) => {
  const ix = createEngagementIndex()
  const A = k(1)
  openBalcony(ix, A)
  for (let s = 1; s <= GARDEN_GIFT_WRITER_MAX; s++) t.ok(addAt(ix, W, s, gift(k(s)), NOW))
  t.is(ix.gardenStall(A, NOW).hidden, false)
  t.ok(addAt(ix, W, GARDEN_GIFT_WRITER_MAX + 1, gift(k(1000)), NOW))
  t.alike(ix.gardenStall(A, NOW, open).pending, [], 'the pick to A left')
  t.is(ix.gardenStall(A, NOW).hidden, true, 'and A says hidden')
  t.is(ix.gardenStall(A, CLOSES - 1).hidden, true, 'while it would be listable')
  t.is(ix.gardenStall(A, CLOSES).hidden, false)
  // The same when A had taken that gift: the shelf row goes with it.
  const took = createEngagementIndex()
  openBalcony(took, A)
  for (let s = 1; s <= GARDEN_GIFT_WRITER_MAX; s++) t.ok(addAt(took, W, s, gift(k(s)), NOW))
  t.ok(add(took, A, 2, take(W, 1)))
  t.alike(took.gardenStall(A, NOW, open).shelf, [{ seq: 2, from: W, gseq: 1 }])
  t.ok(addAt(took, W, GARDEN_GIFT_WRITER_MAX + 1, gift(k(1000)), NOW))
  const out = took.gardenStall(A, NOW, open)
  t.alike(out.shelf, [], 'the shelf row is gone')
  t.is(out.hidden, true, 'and A says hidden')
})
