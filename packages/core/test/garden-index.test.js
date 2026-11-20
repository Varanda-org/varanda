'use strict'

// The Varandinha pointers of the seeder's engagement index (garden(),
// gardenStreet()): latest-wins flags and states, the help rows (follow
// evidence, visibility, one per writer per Brasilia day, the reader window,
// writer fairness), every cap, deletion, purge and paging. No network.
const test = require('brittle')
const { garden: G } = require('@varanda/rpc')
const {
  createEngagementIndex, GARDEN_PAIR_MAX, GARDEN_WRITER_MAX, GARDEN_WRITERS_PER_OWNER, GARDEN_STREET_SCAN
} = require('../lib/engagement-index')
const { gardenRecord, gardenStateRecord, gardenHelpRecord, validRecordCopy } = require('../lib/records')

const O = 'f'.repeat(64)
const W = 'e'.repeat(64)
const HOUR = 3600000
const DAY = 86400000
// hh:00 Brasilia time (UTC-3) on 2026-03-<day>.
const bra = (day, hh) => Date.parse('2026-03-' + String(day).padStart(2, '0') + 'T00:00:00.000Z') + 3 * HOUR + hh * HOUR
const NOW = bra(10, 12)
const iso = (ms) => new Date(ms).toISOString()
const k = (i) => (i + 1).toString(16).padStart(64, '0')
const EMPTY_POTS = [null, null, null, null, null, null]
const follows = () => 1
const open = { followSeq: follows }

function add (ix, author, seq, record) {
  const copy = validRecordCopy(record, seq)
  if (copy === null) throw new Error('fixture record is invalid')
  return ix.add(author, seq, copy)
}

// An on balcony for `owner` (garden() lists nothing for an off or unopened
// one), at a seq no fixture help uses. It holds one record slot.
const OPEN_SEQ = 1000000
function openBalcony (ix, owner, seq = OPEN_SEQ) {
  if (!add(ix, owner, seq, gardenRecord({ on: true, at: iso(NOW - DAY) }))) throw new Error('fixture balcony refused')
}

function help (to, atMs, pot = 0) {
  return gardenHelpRecord({ to, pot, at: iso(atMs) })
}

function seqs (rows) {
  return rows.map((r) => r.author + ':' + r.seq)
}

test('garden: latest-wins flag and state, on or off, deletes fall back', (t) => {
  const ix = createEngagementIndex()
  t.alike(ix.garden(O, NOW), { on: null, state: null, helps: [], given: [], hidden: false })
  t.ok(add(ix, O, 1, gardenRecord({ on: true, at: iso(NOW - 5 * HOUR) })))
  t.ok(add(ix, O, 2, gardenStateRecord({ pots: EMPTY_POTS, n: 1, at: iso(NOW - 4 * HOUR) })))
  t.is(ix.garden(O, NOW).on, 1)
  t.is(ix.garden(O, NOW).state, 2)
  t.ok(add(ix, O, 3, gardenRecord({ on: false, at: iso(NOW - 3 * HOUR) })))
  t.ok(add(ix, O, 4, gardenStateRecord({ pots: EMPTY_POTS, n: 2, at: iso(NOW - 2 * HOUR) })))
  t.is(ix.garden(O, NOW).on, 3, 'an off block is the pointer too')
  t.alike(ix.garden(O, NOW), { on: 3, state: null, helps: [], given: [], hidden: false }, 'an off balcony answers no state')
  t.alike(ix.gardenStreet(W, [O]).rows, [], 'an off balcony is not on the street')
  t.ok(add(ix, O, 5, gardenRecord({ on: true, at: iso(NOW - HOUR) })))
  t.alike(ix.gardenStreet(W, [O]).rows, [{ key: O, on: 5, state: 4 }])
  t.is(ix.stats().records, 5, 'every block holds one slot')
  t.ok(ix.removeRecord(O, 5))
  t.is(ix.garden(O, NOW).on, 3, 'a tombstone falls back to the previous block')
  t.alike(ix.gardenStreet(W, [O]).rows, [], 'and the street follows the fallback')
  t.ok(ix.removeRecord(O, 3))
  t.alike(ix.gardenStreet(W, [O]).rows, [{ key: O, on: 1, state: 4 }])
  t.ok(ix.removeRecord(O, 4))
  t.is(ix.garden(O, NOW).state, 2)
  t.ok(add(ix, O, 5, gardenRecord({ on: false, at: iso(NOW) })), 'a tombstoned seq is not resurrected')
  t.is(ix.garden(O, NOW).on, 1)
  t.ok(ix.removeRecord(O, 1))
  t.ok(ix.removeRecord(O, 2))
  t.alike(ix.garden(O, NOW), { on: null, state: null, helps: [], given: [], hidden: false })
  t.is(ix.stats().records, 0, 'record count back to its start')
})

test('garden: a help is listed with its follow evidence; visibility and follow omit writers', (t) => {
  const ix = createEngagementIndex()
  const A = k(1)
  const B = k(2)
  openBalcony(ix, O)
  t.ok(add(ix, A, 1, help(O, NOW - HOUR, 2)))
  t.ok(add(ix, B, 1, help(O, NOW - 2 * HOUR)))
  t.alike(ix.garden(O, NOW, { followSeq: (w) => (w === A ? 7 : 9) }).helps, [
    { author: A, seq: 1, followSeq: 7 },
    { author: B, seq: 1, followSeq: 9 }
  ])
  const none = ix.garden(O, NOW)
  t.alike(none.helps, [], 'no followSeq: every writer omitted')
  t.is(none.hidden, false, 'a missing follow is no visibility omission')
  const noA = ix.garden(O, NOW, { followSeq: (w) => (w === A ? null : 3) })
  t.alike(seqs(noA.helps), [B + ':1'], 'a writer without followSeq is omitted')
  t.is(noA.hidden, false)
  const throwsA = ix.garden(O, NOW, { followSeq: (w) => { if (w === A) throw new Error('x'); return 3 } })
  t.alike(seqs(throwsA.helps), [B + ':1'], 'a throwing followSeq omits the writer')
  for (const bad of [0, -1, 1.5, '2', NaN]) {
    t.alike(ix.garden(O, NOW, { followSeq: () => bad }).helps, [], 'a non-seq followSeq omits: ' + bad)
  }
  const hidA = ix.garden(O, NOW, { followSeq: follows, visible: (w) => w !== A })
  t.alike(seqs(hidA.helps), [B + ':1'])
  t.is(hidA.hidden, true, 'hidden says a writer was omitted for visibility')
  const hidThrow = ix.garden(O, NOW, { followSeq: follows, visible: () => { throw new Error('x') } })
  t.alike(hidThrow.helps, [])
  t.is(hidThrow.hidden, true, 'a throwing visible hides')
  t.alike(ix.garden(W, NOW, open).helps, [], 'another balcony has no rows')
  t.is(ix.stats().records, 3)
})

test('garden: a self help is never listed, takes no slot and never pauses', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, O, 1, help(O, NOW)))
  t.is(ix.stats().records, 1, 'no slot')
  t.alike(ix.garden(O, NOW, open).helps, [], 'never listed')
  t.alike(ix.garden(O, NOW, open).given, [], 'never given either')
  const full = createEngagementIndex({ maxRecords: 0 })
  t.ok(add(full, O, 1, help(O, NOW)), 'true even with no room')
  t.is(add(full, O, 2, help(W, NOW)), false, 'while a real help pauses at the cap')
})

test('garden: one row per writer per Brasilia day, the lowest stored seq', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  // 2026-03-10 01:00Z is 22:00 of 2026-03-09 in Brasilia: the same day as 2026-03-09 09:00.
  t.ok(add(ix, W, 1, help(O, bra(9, 9))))
  t.ok(add(ix, W, 2, help(O, Date.parse('2026-03-10T01:00:00.000Z'))))
  t.is(G.dayStart(bra(9, 9)), G.dayStart(Date.parse('2026-03-10T01:00:00.000Z')))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':1'], 'one row across UTC midnight, the lowest seq')
  t.ok(add(ix, W, 3, help(O, bra(10, 0))))
  t.ok(add(ix, W, 4, help(O, bra(10, 0) - 1)))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':3', W + ':1'], '00:00 Brasilia starts a new day, the seq 4 row joins day 9')
  t.ok(ix.removeRecord(W, 1))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':3', W + ':2'], 'the next stored seq of that day takes over')
})

test('garden: a tombstoned help leaves the list and the next of the four is listed', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let s = 1; s <= GARDEN_PAIR_MAX; s++) t.ok(add(ix, W, s, help(O, bra(10, s))))
  t.is(ix.stats().records, GARDEN_PAIR_MAX + 1)
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':1'])
  for (let s = 1; s < GARDEN_PAIR_MAX; s++) {
    t.ok(ix.removeRecord(W, s))
    t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':' + (s + 1)], 'seq ' + (s + 1) + ' listed after ' + s + ' is deleted')
  }
  t.ok(ix.removeRecord(W, GARDEN_PAIR_MAX))
  t.alike(ix.garden(O, NOW, open).helps, [])
  t.is(ix.stats().records, 1, 'every row freed its slot')
})

test('garden: the reader window and the future cut', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const cases = [
    [NOW - G.GARDEN_HELP_WINDOW_MS, true],
    [NOW - G.GARDEN_HELP_WINDOW_MS - 1, false],
    [NOW + G.GARDEN_MAX_FUTURE_MS, true],
    [NOW + G.GARDEN_MAX_FUTURE_MS + 1, false],
    [NOW, true]
  ]
  cases.forEach(([atMs], i) => t.ok(add(ix, k(i), 1, help(O, atMs))))
  const listed = new Set(ix.garden(O, NOW, open).helps.map((r) => r.author))
  cases.forEach(([atMs, want], i) => t.is(listed.has(k(i)), want, iso(atMs)))
  t.is(ix.stats().records, cases.length + 1, 'rows out of the window still hold their slot')
  t.is(ix.garden(O, NOW + 2 * DAY, open).helps.length, 3, 'a later clock lists the once future rows and drops the old ones')
})

test('garden: given lists the own live helps in the window, newest first, capped', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, O, 1, help(k(1), NOW - 2 * HOUR)))
  t.ok(add(ix, O, 2, help(k(2), NOW - HOUR)))
  t.ok(add(ix, O, 3, help(k(3), NOW - G.GARDEN_HELP_WINDOW_MS - 1)))
  t.ok(add(ix, O, 4, help(k(4), NOW + G.GARDEN_MAX_FUTURE_MS + 1)))
  t.alike(ix.garden(O, NOW).given, [2, 1])
  t.ok(ix.removeRecord(O, 2))
  t.alike(ix.garden(O, NOW).given, [1], 'a deleted help leaves given')
  const many = createEngagementIndex()
  openBalcony(many, O)
  for (let i = 0; i < G.GARDEN_HELP_ROWS + 6; i++) t.ok(add(many, O, i + 1, help(k(i), NOW - (i + 1) * 60000)))
  const given = many.garden(O, NOW).given
  t.is(given.length, G.GARDEN_HELP_ROWS)
  t.is(given[0], 1, 'newest first')
})

test('garden: every writer is listed before any writer gets a second day', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const busy = [k(100), k(101), k(102), k(103), k(104)]
  // Five days inside the window, newest first: the busy writers keep their
  // four latest seqs.
  const days = [bra(11, 6), bra(10, 6), bra(9, 6), bra(8, 6), bra(7, 18)]
  // Writers spread over the six pots (writer i to pot i % 6): pots 0 to 4
  // hold one busy writer each, so each lists 4 rows, and pot 5 only its two
  // quiet writers.
  const potOf = (w) => [...busy, ...quiet].indexOf(w) % G.GARDEN_POTS
  const quiet = []
  for (let i = 0; i < 10; i++) quiet.push(k(200 + i))
  for (const w of busy) days.forEach((atMs, i) => t.ok(add(ix, w, i + 1, help(O, atMs, potOf(w)))))
  for (const w of quiet) t.ok(add(ix, w, 1, help(O, bra(7, 19), potOf(w))))
  t.is(ix.stats().records, 1 + busy.length * GARDEN_PAIR_MAX + quiet.length, 'the lowest seq busy row was dropped and freed')
  const helps = ix.garden(O, NOW, open).helps
  t.is(helps.length, 5 * 4 + 2)
  const authors = new Set(helps.map((r) => r.author))
  for (const w of [...busy, ...quiet]) t.ok(authors.has(w), 'listed: ' + w.slice(-3))
  const planted = { plant: 'tomate', at: iso(bra(1, 0)), water: iso(bra(1, 0)), w: 0 }
  const fold = G.foldHelps({
    owner: O,
    now: NOW,
    pots: new Array(G.GARDEN_POTS).fill(planted),
    helps: helps.map((r) => ({ author: r.author, seq: r.seq, record: help(O, rowAt(r), potOf(r.author)), follow: { type: 'follow', key: O, on: true, at: iso(bra(1, 0)) } }))
  })
  t.is(fold.helpers.length, busy.length + quiet.length, 'the reader fold sees every helper')

  function rowAt (r) {
    return busy.includes(r.author) ? days[r.seq - 1] : bra(7, 19)
  }
})

test('garden: per pair cap keeps the latest listable seqs, an unlistable incoming row is skipped without a slot', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const base = ix.stats().records
  // Days 10, 9, 9 and 8 in Brasilia: seq 3 repeats day 9 and is never listed.
  for (let s = 1; s <= GARDEN_PAIR_MAX; s++) t.ok(add(ix, W, s, help(O, NOW - s * DAY / 2)))
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX)
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':1', W + ':2', W + ':4'])
  t.ok(add(ix, W, 10, help(O, NOW - 2 * DAY - 1)), 'a second day 8 row: true')
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX, 'and no slot')
  t.ok(add(ix, W, 11, help(O, bra(7, 18))), 'a new day')
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX, 'evicts the unlistable seq 3 and frees its slot')
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':1', W + ':2', W + ':4', W + ':11'])
  t.is(ix.removeRecord(W, 3), false, 'the evicted seq is no longer indexed')
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX, 'and its delete frees nothing more')
  t.ok(add(ix, W, 12, help(O, bra(11, 6))), 'another new day, every kept row listable')
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX, 'the lowest seq leaves')
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':2', W + ':4', W + ':11', W + ':12'], 'day 10 lost seq 1, the row dated after now listed last')
  t.is(ix.removeRecord(W, 1), false)
  t.ok(ix.removeRecord(W, 12))
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX - 1)
})

test('garden: per writer cap of help rows, the lowest seq dropped and freed', (t) => {
  const ix = createEngagementIndex()
  for (const owner of [k(0), k(1), k(500), k(501), W]) openBalcony(ix, owner)
  const base = ix.stats().records
  for (let i = 0; i < GARDEN_WRITER_MAX; i++) t.ok(add(ix, W, i + 1, help(k(i), NOW - (GARDEN_WRITER_MAX - i) * 60000)))
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX)
  t.alike(seqs(ix.garden(k(0), NOW, open).helps), [W + ':1'])
  t.ok(add(ix, W, 100, help(k(500), NOW - DAY)), 'an older date still takes a slot')
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX, 'the lowest seq left and freed its slot')
  t.alike(ix.garden(k(0), NOW, open).helps, [], 'the lowest seq balcony lost its row')
  t.alike(seqs(ix.garden(k(500), NOW, open).helps), [W + ':100'])
  t.ok(add(ix, W, 101, help(k(501), NOW)))
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX)
  t.alike(ix.garden(k(1), NOW, open).helps, [], 'then the next lowest seq')
  t.alike(seqs(ix.garden(k(501), NOW, open).helps), [W + ':101'])
  t.is(ix.garden(W, NOW).given.length, G.GARDEN_HELP_ROWS)
})

test('garden: far-future helps never cost an in-window help its pair slot', (t) => {
  const far = Date.parse('9999-12-31T00:00:00.000Z')
  const late = GARDEN_PAIR_MAX + 1
  const same = createEngagementIndex()
  openBalcony(same, O)
  for (let s = 1; s <= GARDEN_PAIR_MAX; s++) t.ok(add(same, W, s, help(O, far)))
  t.ok(add(same, W, late, help(O, NOW - HOUR)))
  t.alike(seqs(same.garden(O, NOW, open).helps), [W + ':' + late], 'four far-future rows of one day keep no in-window help out')
  t.ok(same.removeDiary(W))
  t.is(same.stats().records, 1, 'record count back to its start')
  const spread = createEngagementIndex()
  openBalcony(spread, O)
  for (let s = 1; s <= GARDEN_PAIR_MAX; s++) t.ok(add(spread, W, s, help(O, far - s * DAY)))
  t.ok(add(spread, W, late, help(O, NOW - HOUR)))
  t.alike(seqs(spread.garden(O, NOW, open).helps), [W + ':' + late], 'four far-future days keep no in-window help out')
  t.is(spread.stats().records, GARDEN_PAIR_MAX + 1, 'the lowest seq left and freed its slot')
  t.is(spread.removeRecord(W, 1), false)
  t.ok(spread.removeDiary(W))
  t.is(spread.stats().records, 1, 'record count back to its start')
})

test('garden: far-future helps never cost an in-window help its writer slot', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const base = ix.stats().records
  const far = Date.parse('9999-12-31T00:00:00.000Z')
  for (let i = 0; i < GARDEN_WRITER_MAX; i++) t.ok(add(ix, W, i + 1, help(k(i), far)))
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX)
  t.ok(add(ix, W, GARDEN_WRITER_MAX + 1, help(O, NOW - HOUR)))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':' + (GARDEN_WRITER_MAX + 1)], 'the in-window help is listed')
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX)
  t.is(ix.removeRecord(W, 1), false, 'the lowest seq left')
  t.ok(ix.removeDiary(W))
  t.is(ix.stats().records, base, 'record count back to its start')
})

test('garden: past the pair cap a same-day duplicate leaves, never the lowest seq of its day', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const base = ix.stats().records
  t.ok(add(ix, W, 1, help(O, bra(7, 18))))
  t.ok(add(ix, W, 2, help(O, bra(7, 20))), 'a second help on day 7, which an honest node refuses')
  t.ok(add(ix, W, 3, help(O, bra(8, 9))))
  t.ok(add(ix, W, 4, help(O, bra(9, 9))))
  t.ok(add(ix, W, 5, help(O, bra(10, 9))))
  t.is(ix.stats().records - base, GARDEN_PAIR_MAX)
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':5', W + ':4', W + ':3', W + ':1'], 'day 7 lists seq 1, never seq 2')
  t.is(ix.removeRecord(W, 2), false, 'the duplicate seq 2 was the one evicted')
  t.ok(ix.removeRecord(W, 1))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':5', W + ':4', W + ':3'], 'seq 2 is not stored, so day 7 lists nothing')
  t.ok(ix.removeDiary(W))
  t.is(ix.stats().records, base, 'record count back to its start')

  const kept = createEngagementIndex()
  openBalcony(kept, O)
  t.ok(add(kept, W, 1, help(O, bra(7, 18))))
  t.ok(add(kept, W, 2, help(O, bra(7, 20))))
  t.ok(add(kept, W, 3, help(O, bra(8, 9))))
  t.ok(add(kept, W, 4, help(O, bra(9, 9))))
  t.alike(seqs(kept.garden(O, NOW, open).helps), [W + ':4', W + ':3', W + ':1'])
  t.ok(kept.removeRecord(W, 1))
  t.alike(seqs(kept.garden(O, NOW, open).helps), [W + ':4', W + ':3', W + ':2'], 'a stored duplicate is listed once the lowest seq of its day is deleted')
  t.ok(kept.removeDiary(W))
  t.is(kept.stats().records, 1, 'record count back to its start')
})

test('garden: past the writer cap a same-day duplicate leaves, never the lowest seq of any day', (t) => {
  const ix = createEngagementIndex()
  for (const owner of [O, k(3), k(500)]) openBalcony(ix, owner)
  const base = ix.stats().records
  t.ok(add(ix, W, 1, help(O, bra(9, 9))))
  t.ok(add(ix, W, 2, help(O, bra(9, 10))))
  for (let s = 3; s <= GARDEN_WRITER_MAX; s++) t.ok(add(ix, W, s, help(k(s), NOW - (GARDEN_WRITER_MAX - s + 1) * 60000)))
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX)
  t.ok(add(ix, W, GARDEN_WRITER_MAX + 1, help(k(500), NOW)))
  t.is(ix.stats().records - base, GARDEN_WRITER_MAX)
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':1'], 'day 9 still lists seq 1')
  t.is(ix.removeRecord(W, 2), false, 'the duplicate seq 2 was the one evicted')
  t.alike(seqs(ix.garden(k(3), NOW, open).helps), [W + ':3'], 'the lowest seq of another balcony stays')
  t.alike(seqs(ix.garden(k(500), NOW, open).helps), [W + ':' + (GARDEN_WRITER_MAX + 1)])
  t.ok(ix.removeDiary(W))
  t.is(ix.stats().records, base, 'record count back to its start')
})

test('garden: writers per balcony cap, a new writer past it takes no slot', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const base = ix.stats().records
  for (let i = 0; i < GARDEN_WRITERS_PER_OWNER; i++) t.ok(add(ix, k(i), 1, help(O, NOW - DAY, i % G.GARDEN_POTS)))
  t.is(ix.stats().records - base, GARDEN_WRITERS_PER_OWNER)
  const extra = k(GARDEN_WRITERS_PER_OWNER)
  t.ok(add(ix, extra, 1, help(O, NOW)), 'true')
  t.is(ix.stats().records - base, GARDEN_WRITERS_PER_OWNER, 'no slot')
  t.ok(add(ix, k(0), 2, help(O, NOW)), 'a writer already listed may add another day')
  t.is(ix.stats().records - base, GARDEN_WRITERS_PER_OWNER + 1)
  const helps = ix.garden(O, NOW, open).helps
  t.is(helps.length, G.GARDEN_HELP_ROWS)
  t.absent(helps.some((r) => r.author === extra), 'never listed')
  t.ok(ix.removeDiary(k(1)))
  t.ok(add(ix, extra, 2, help(O, NOW)), 'a freed writer place takes the new writer')
  t.is(ix.stats().records - base, GARDEN_WRITERS_PER_OWNER + 1)
})

function addAt (ix, author, seq, record, now) {
  const copy = validRecordCopy(record, seq)
  if (copy === null) throw new Error('fixture record is invalid')
  return ix.add(author, seq, copy, { now })
}

test('garden: at the writers cap, a writer with no listable row gives its place to a listable help', (t) => {
  let freed = 0
  const ix = createEngagementIndex({ onFreed: () => freed++ })
  openBalcony(ix, O)
  const base = ix.stats().records
  // Every place is held by rows older than the window at now; k(0) holds
  // the oldest newest row and two rows.
  const stale = (i) => NOW - G.GARDEN_HELP_WINDOW_MS - (GARDEN_WRITERS_PER_OWNER - i) * 60000
  t.ok(addAt(ix, k(0), 1, help(O, stale(0) - 60000), NOW))
  for (let i = 0; i < GARDEN_WRITERS_PER_OWNER; i++) t.ok(addAt(ix, k(i), 2, help(O, stale(i)), NOW))
  t.is(ix.stats().records - base, GARDEN_WRITERS_PER_OWNER + 1)
  const extra = k(GARDEN_WRITERS_PER_OWNER)
  freed = 0
  t.ok(addAt(ix, extra, 1, help(O, NOW - HOUR), NOW), 'the new writer is stored')
  t.alike(seqs(ix.garden(O, NOW, open).helps), [extra + ':1'], 'and listed')
  t.is(ix.garden(O, NOW, open).hidden, false)
  t.is(ix.removeRecord(k(0), 1), false, 'the evicted writer row is gone')
  t.is(ix.removeRecord(k(0), 2), false, 'every row of it')
  t.is(ix.stats().records - base, GARDEN_WRITERS_PER_OWNER, 'its two slots freed, one taken')
  t.ok(freed > 0, 'the freed slots wake paused diaries')
  for (let i = 0; i <= GARDEN_WRITERS_PER_OWNER; i++) t.ok(ix.removeDiary(k(i)))
  t.is(ix.stats().records, base, 'record count back to its start')
})

test('garden: at the writers cap with every row listable, a refused help hides the balcony until it leaves the window', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i < GARDEN_WRITERS_PER_OWNER; i++) t.ok(addAt(ix, k(i), 1, help(O, NOW - HOUR), NOW))
  const base = ix.stats().records
  const extra = k(GARDEN_WRITERS_PER_OWNER)
  const refusedAt = NOW - 2 * HOUR
  t.ok(addAt(ix, extra, 1, help(O, refusedAt), NOW), 'skipped: true')
  t.is(ix.stats().records, base, 'no slot, no eviction')
  t.is(ix.garden(O, NOW, open).hidden, true, 'a help it might list was refused')
  t.is(ix.garden(O, refusedAt + G.GARDEN_HELP_WINDOW_MS, open).hidden, true, 'still listable at the window edge')
  t.is(ix.garden(O, refusedAt + G.GARDEN_HELP_WINDOW_MS + 1, open).hidden, false, 'out of the window: honest again')
  t.is(ix.garden(W, NOW, open).hidden, false, 'another balcony is not full')
  t.ok(ix.removeDiary(O))
  openBalcony(ix, O)
  t.is(ix.garden(O, NOW, open).hidden, true, 'the mark outlives the owner diary, like the rows addressed to it')
  ix.clear()
  openBalcony(ix, O)
  t.is(ix.garden(O, NOW, open).hidden, false, 'clear resets it')
})

test('garden: at the writers cap, an incoming help that cannot be listed is skipped and marks nothing', (t) => {
  const far = NOW + G.GARDEN_MAX_FUTURE_MS + 1
  const old = NOW - G.GARDEN_HELP_WINDOW_MS - 1
  const full = createEngagementIndex()
  openBalcony(full, O)
  for (let i = 0; i < GARDEN_WRITERS_PER_OWNER; i++) t.ok(addAt(full, k(i), 1, help(O, NOW - HOUR), NOW))
  const base = full.stats().records
  t.ok(addAt(full, k(GARDEN_WRITERS_PER_OWNER), 1, help(O, far), NOW), 'far future: true')
  t.ok(addAt(full, k(GARDEN_WRITERS_PER_OWNER + 1), 1, help(O, old), NOW), 'stale: true')
  t.is(full.stats().records, base, 'no slot')
  t.is(full.garden(O, NOW, open).hidden, false, 'a row that could never be listed hides nothing')
  const stale = createEngagementIndex()
  openBalcony(stale, O)
  for (let i = 0; i < GARDEN_WRITERS_PER_OWNER; i++) t.ok(addAt(stale, k(i), 1, help(O, old - i), NOW))
  const before = stale.stats().records
  t.ok(addAt(stale, k(GARDEN_WRITERS_PER_OWNER), 1, help(O, far), NOW))
  t.ok(addAt(stale, k(GARDEN_WRITERS_PER_OWNER + 1), 1, help(O, old), NOW))
  t.is(stale.stats().records, before, 'nor does it evict a writer')
  t.is(stale.removeRecord(k(GARDEN_WRITERS_PER_OWNER - 1), 1), true, 'the oldest writer is still there')
})

test('garden: at the writers cap without a clock, a new writer is refused and the balcony says hidden', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i < GARDEN_WRITERS_PER_OWNER; i++) t.ok(add(ix, k(i), 1, help(O, NOW - G.GARDEN_HELP_WINDOW_MS - HOUR)))
  const base = ix.stats().records
  t.ok(add(ix, k(GARDEN_WRITERS_PER_OWNER), 1, help(O, NOW - HOUR)), 'skipped: true')
  t.is(ix.stats().records, base, 'no slot and no eviction without a clock')
  t.alike(ix.garden(O, NOW, open).helps, [])
  t.is(ix.garden(O, NOW, open).hidden, true)
})

test('garden: a help that evicts its own writer row is net zero and passes a full budget', (t) => {
  for (const opts of [{ perAuthorMax: GARDEN_PAIR_MAX }, { maxRecords: GARDEN_PAIR_MAX + 1 }]) {
    const ix = createEngagementIndex(opts)
    openBalcony(ix, O)
    // Four listable days, then a fifth one: every row is the first of its day.
    const days = [bra(9, 18), bra(8, 18), bra(7, 18), bra(10, 1)]
    days.forEach((atMs, i) => t.ok(add(ix, W, i + 1, help(O, atMs))))
    const base = ix.stats().records
    t.ok(add(ix, W, 10, help(O, bra(11, 6))), 'a fifth help is stored: ' + JSON.stringify(opts))
    t.is(ix.stats().records, base, 'the count is unchanged')
    t.is(ix.removeRecord(W, 1), false, 'the lowest seq left')
    t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':4', W + ':2', W + ':3', W + ':10'], 'the new row replaced it')
    if (opts.perAuthorMax) t.is(add(ix, W, 11, help(k(9), NOW)), false, 'a help that evicts nothing still pauses at the author cap')
    else t.is(add(ix, k(1), 1, help(O, NOW)), false, 'another writer still pauses at the budget')
  }
})

test('garden: with a clock, the pair cap keeps a day row the window edge left alone', (t) => {
  const rows = [bra(7, 1), bra(7, 23), bra(8, 9), bra(9, 9)]
  t.is(G.dayStart(rows[0]), G.dayStart(rows[1]), 'seq 1 and 2 share a Brasilia day')
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  rows.forEach((atMs, i) => t.ok(addAt(ix, W, i + 1, help(O, atMs), NOW)))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':4', W + ':3', W + ':2'], 'seq 1 is out of the window, seq 2 lists day 7')
  t.ok(addAt(ix, W, 5, help(O, bra(10, 9)), NOW))
  t.is(ix.removeRecord(W, 1), false, 'the out of window seq 1 was evicted')
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':5', W + ':4', W + ':3', W + ':2'], 'the in-window seq 2 stays listed')
  const old = createEngagementIndex()
  openBalcony(old, O)
  rows.forEach((atMs, i) => t.ok(add(old, W, i + 1, help(O, atMs))))
  t.ok(add(old, W, 5, help(O, bra(10, 9))))
  t.is(old.removeRecord(W, 2), false, 'without a clock the same-day duplicate seq 2 leaves, as before')
})

test('garden: helps dated after the seeder clock rank after every honest one', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  for (let i = 0; i < G.GARDEN_HELP_ROWS; i++) t.ok(add(ix, k(i), 1, help(O, NOW + 23 * HOUR, i % G.GARDEN_POTS)))
  const honest = k(500)
  t.ok(add(ix, honest, 1, help(O, NOW - HOUR)))
  const helps = ix.garden(O, NOW, open).helps
  t.is(helps.length, G.GARDEN_HELP_ROWS)
  t.is(helps[0].author, honest, 'the honest help is listed, first')
  t.ok(add(ix, k(600), 1, help(O, NOW + HOUR)))
  t.is(ix.garden(O, NOW, open).helps[1].author, k(600), 'among future rows, the nearest to now first')
})

// The reader fold counts a help only for a pot planted on or before it, so
// rows naming one pot (an empty one here) must not take the places of
// another pot's honest rows.
test('garden: helps for an unplanted pot never crowd out the honest helps of another pot', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const start = ix.stats().records
  const honest = [k(1), k(2), k(3)]
  for (const w of honest) t.ok(add(ix, w, 1, help(O, NOW - 10 * HOUR, 0)))
  const flood = []
  for (let i = 0; i < G.GARDEN_HELP_ROWS; i++) {
    flood.push(k(100 + i))
    t.ok(add(ix, k(100 + i), 1, help(O, NOW - HOUR, 5)))
  }
  const helps = ix.garden(O, NOW, open).helps
  const authors = helps.map((r) => r.author)
  for (const w of honest) t.ok(authors.includes(w), 'the honest help is listed: ' + w.slice(-1))
  t.ok(helps.filter((r) => flood.includes(r.author)).length <= G.GARDEN_HELP_ROWS / G.GARDEN_POTS, 'at most 4 rows name pot 5')
  t.is(helps.length, honest.length + G.GARDEN_HELP_ROWS / G.GARDEN_POTS)
  const planted = { plant: 'tomate', at: iso(NOW - DAY), water: iso(NOW - DAY), w: 0 }
  const fold = G.foldHelps({
    owner: O,
    now: NOW,
    pots: [planted, null, null, null, null, null],
    helps: helps.map((r) => ({ author: r.author, seq: r.seq, record: help(O, honest.includes(r.author) ? NOW - 10 * HOUR : NOW - HOUR, honest.includes(r.author) ? 0 : 5), follow: { type: 'follow', key: O, on: true, at: iso(NOW - DAY) } }))
  })
  t.is(fold.perPot[0], G.GARDEN_HELP_PER_POT, 'the reader counts the honest helps')
  for (const w of [...honest, ...flood]) t.ok(ix.removeDiary(w))
  t.is(ix.stats().records, start, 'record count back to its start')
})

test('garden: at most GARDEN_HELP_ROWS / GARDEN_POTS rows per pot, the last ranked row of each pot left out', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const perPot = G.GARDEN_HELP_ROWS / G.GARDEN_POTS
  const dropped = []
  for (let p = 0; p < G.GARDEN_POTS; p++) {
    for (let j = 0; j <= perPot; j++) {
      // Pot 0 holds the newest rows, so a global pick of the newest 24
      // would fill pots 0 to 3 and leave pot 5 out.
      const w = k(10 * p + j)
      t.ok(add(ix, w, 1, help(O, NOW - (p * (perPot + 1) + j + 1) * HOUR, p)))
      if (j === perPot) dropped.push(w)
    }
  }
  const helps = ix.garden(O, NOW, open).helps
  t.is(helps.length, G.GARDEN_HELP_ROWS)
  for (let p = 0; p < G.GARDEN_POTS; p++) {
    const inPot = helps.filter((r) => Math.floor((parseInt(r.author, 16) - 1) / 10) === p)
    t.is(inPot.length, perPot, 'pot ' + p + ' lists ' + perPot + ' rows')
  }
  for (const w of dropped) t.absent(helps.some((r) => r.author === w), 'the last ranked row of its pot is left out')
  const atOf = (r) => { const n = parseInt(r.author, 16) - 1; return NOW - ((Math.floor(n / 10)) * (perPot + 1) + (n % 10) + 1) * HOUR }
  for (let i = 1; i < helps.length; i++) t.ok(atOf(helps[i - 1]) >= atOf(helps[i]), 'the answer is newest first')
})

test('garden: inside a pot every writer is listed before a writer gets a second day', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const busy = k(1)
  const days = [bra(10, 11), bra(9, 11), bra(8, 11)]
  days.forEach((atMs, i) => t.ok(add(ix, busy, i + 1, help(O, atMs, 2))))
  const quiet = [k(2), k(3), k(4)]
  for (const w of quiet) t.ok(add(ix, w, 1, help(O, bra(7, 20), 2)))
  const helps = ix.garden(O, NOW, open).helps
  t.alike(seqs(helps), [busy + ':1', ...quiet.map((w) => w + ':1')], 'the three other writers before the busy writer\'s second day')
})

test('garden: the per writer and day row is chosen across pots, and its pot is the bucket', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  t.ok(add(ix, W, 5, help(O, bra(10, 8), 1)))
  t.ok(add(ix, W, 6, help(O, bra(10, 9), 3)))
  // Pot 3 is full of newer rows: W's row is listed only if it sits in pot 1.
  const others = [k(1), k(2), k(3), k(4)]
  for (const w of others) t.ok(add(ix, w, 1, help(O, bra(10, 10), 3)))
  const helps = ix.garden(O, NOW, open).helps
  t.ok(seqs(helps).includes(W + ':5'), 'the lowest seq of the day is listed, under pot 1')
  t.absent(seqs(helps).includes(W + ':6'), 'the later seq of the same day is not')
  t.is(helps.length, 1 + others.length)
})

test('garden: a row dated after now ranks last inside its pot', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const ahead = k(100)
  t.ok(add(ix, ahead, 1, help(O, NOW + HOUR, 0)))
  const past = [k(1), k(2), k(3), k(4)]
  for (const w of past) t.ok(add(ix, w, 1, help(O, NOW - 20 * HOUR, 0)))
  const later = k(200)
  t.ok(add(ix, later, 1, help(O, NOW + HOUR, 1)))
  t.ok(add(ix, k(5), 1, help(O, NOW - 30 * HOUR, 1)))
  const helps = ix.garden(O, NOW, open).helps
  t.absent(helps.some((r) => r.author === ahead), 'the future row is the one its full pot leaves out')
  t.is(helps.length, past.length + 2)
  t.is(helps.at(-1).author, later, 'a future row in a pot with room is listed, last')
})

test('garden: an off or never opened balcony answers no helps, given or state, without a writer walk', (t) => {
  for (const off of [true, false]) {
    const ix = createEngagementIndex()
    if (off) {
      t.ok(add(ix, O, 1, gardenRecord({ on: true, at: iso(NOW - 3 * HOUR) })))
      t.ok(add(ix, O, 2, gardenStateRecord({ pots: EMPTY_POTS, n: 1, at: iso(NOW - 2 * HOUR) })))
      t.ok(add(ix, O, 3, gardenRecord({ on: false, at: iso(NOW - HOUR) })))
    } else {
      t.ok(add(ix, O, 2, gardenStateRecord({ pots: EMPTY_POTS, n: 1, at: iso(NOW - 2 * HOUR) })))
    }
    t.ok(add(ix, O, 4, help(W, NOW - HOUR)))
    for (let i = 0; i < 3; i++) t.ok(add(ix, k(i), 1, help(O, NOW - HOUR)))
    let calls = 0
    const g = ix.garden(O, NOW, { visible: () => { calls++; return true }, followSeq: () => { calls++; return 1 } })
    t.alike(g, { on: off ? 3 : null, state: null, helps: [], given: [], hidden: false }, off ? 'off' : 'never opened')
    t.is(calls, 0, 'visible and followSeq are never called')
  }
})

test('garden: removeDiary of a writer and of an owner', (t) => {
  const ix = createEngagementIndex()
  const A = k(1)
  openBalcony(ix, A)
  t.ok(add(ix, O, 1, gardenRecord({ on: true, at: iso(NOW - DAY) })))
  t.ok(add(ix, O, 2, gardenStateRecord({ pots: EMPTY_POTS, n: 1, at: iso(NOW - DAY) })))
  t.ok(add(ix, O, 3, help(A, NOW - HOUR)))
  t.ok(add(ix, A, 1, help(O, NOW - HOUR)))
  t.ok(add(ix, W, 1, help(O, NOW - 2 * HOUR)))
  t.ok(add(ix, W, 2, help(A, NOW - 2 * HOUR)))
  t.is(ix.stats().records, 7)
  t.ok(ix.removeDiary(W))
  t.alike(seqs(ix.garden(O, NOW, open).helps), [A + ':1'], 'the writer rows leave every balcony')
  t.alike(seqs(ix.garden(A, NOW, open).helps), [O + ':3'])
  t.is(ix.stats().records, 5)
  t.ok(ix.removeDiary(O))
  t.alike(ix.garden(O, NOW, open), { on: null, state: null, helps: [], given: [], hidden: false }, 'no balcony block: nothing listed')
  t.alike(ix.garden(A, NOW, open).helps, [], 'the owner rows to others leave')
  t.alike(ix.gardenStreet(W, [O]).rows, [])
  t.is(ix.stats().records, 2)
  openBalcony(ix, O)
  const back = ix.garden(O, NOW, open)
  t.is(back.state, null)
  t.alike(back.given, [])
  t.alike(seqs(back.helps), [A + ':1'], 'rows addressed to the owner belong to their writers and stay')
  t.ok(ix.removeDiary(A))
  t.alike(ix.garden(O, NOW, open).helps, [])
  t.ok(ix.removeDiary(O))
  t.is(ix.stats().records, 0, 'record count back to its start')
  openBalcony(ix, O)
  t.ok(add(ix, A, 5, help(O, NOW)))
  ix.clear()
  t.alike(ix.garden(O, NOW, open).helps, [], 'clear purges the rows')
  t.is(ix.stats().records, 0)
})

test('garden: a duplicate seq is ignored across the three types', (t) => {
  const ix = createEngagementIndex()
  openBalcony(ix, O)
  const base = ix.stats().records
  t.ok(add(ix, W, 1, gardenRecord({ on: true, at: iso(NOW) })))
  t.ok(add(ix, W, 2, gardenStateRecord({ pots: EMPTY_POTS, n: 1, at: iso(NOW) })))
  t.ok(add(ix, W, 3, help(O, NOW)))
  t.ok(add(ix, W, 1, gardenRecord({ on: false, at: iso(NOW) })))
  t.ok(add(ix, W, 1, help(O, NOW)))
  t.ok(add(ix, W, 2, gardenRecord({ on: false, at: iso(NOW) })))
  t.ok(add(ix, W, 3, help(O, NOW + HOUR)))
  t.ok(add(ix, W, 3, gardenStateRecord({ pots: EMPTY_POTS, n: 2, at: iso(NOW) })))
  t.is(ix.stats().records - base, 3)
  t.alike(ix.gardenStreet(O, [W]).rows, [{ key: W, on: 1, state: 2 }], 'the first block of each seq stands')
  t.alike(seqs(ix.garden(O, NOW, open).helps), [W + ':3'])
  t.alike(ix.garden(W, NOW).given, [3])
})

test('garden: hostile records and arguments never throw', (t) => {
  const ix = createEngagementIndex()
  const bad = [
    { type: 'garden', on: 'yes', at: iso(NOW) },
    { type: 'garden', at: iso(NOW) },
    { type: 'garden-state', pots: 'x', n: 1, at: iso(NOW) },
    { type: 'garden-help', to: O.toUpperCase(), pot: 0, at: iso(NOW) },
    { type: 'garden-help', to: { toString: () => O }, pot: 0, at: iso(NOW) },
    { type: 'garden-help', to: O, pot: 6, at: iso(NOW) },
    { type: 'garden-help', to: O, pot: 1.5, at: iso(NOW) },
    { type: 'garden-help', to: O, pot: 0, at: 5 },
    { type: 'garden-help', to: O, pot: 0, at: 'not a date' },
    { type: 'garden-help', to: O, pot: 0, get at () { throw new Error('x') } }
  ]
  bad.forEach((r, i) => t.is(ix.add(W, i + 1, r), false))
  t.is(ix.stats().records, 0)
  for (const now of [NaN, Infinity, '1', null]) t.is(ix.garden(O, now), null)
  t.is(ix.garden('x', NOW), null)
  t.is(ix.garden(O, NOW, null), null, 'a null options bag')
  t.is(ix.gardenStreet(O, null), null, 'followed must be iterable')
  t.is(ix.gardenStreet(O, [W], { cursor: 'x' }), null)
  t.is(ix.gardenStreet('x', [W]), null)
  t.alike(ix.gardenStreet(O, [5, null, 'x', W.toUpperCase()]), { rows: [], next: null }, 'junk keys are skipped')
  const throwing = { [Symbol.iterator] () { throw new Error('x') } }
  t.is(ix.gardenStreet(O, throwing), null)
  t.ok(add(ix, W, 20, gardenRecord({ on: true, at: iso(NOW) })))
  t.alike(ix.gardenStreet(O, [W], { visible: () => { throw new Error('x') } }).rows, [], 'a throwing visible hides')
})

test('gardenStreet: pages of GARDEN_STREET_PAGE rows, sorted keys, cursor strictly after', (t) => {
  const ix = createEngagementIndex()
  const page = G.GARDEN_STREET_PAGE
  const keys = []
  for (let i = 0; i < page + 5; i++) {
    keys.push(k(i))
    t.ok(add(ix, k(i), 1, gardenRecord({ on: true, at: iso(NOW) })))
  }
  const followed = new Set(keys.slice().reverse())
  const first = ix.gardenStreet(O, followed)
  t.is(first.rows.length, page)
  t.alike(first.rows.map((r) => r.key), keys.slice(0, page))
  t.is(first.next, keys[page - 1])
  t.alike(first.rows[0], { key: k(0), on: 1, state: null })
  const second = ix.gardenStreet(O, followed, { cursor: first.next })
  t.alike(second.rows.map((r) => r.key), keys.slice(page))
  t.is(second.next, null)
  const exact = ix.gardenStreet(O, keys.slice(0, page))
  t.is(exact.rows.length, page)
  t.is(exact.next, null, 'a full page with no keys left ends the walk')
  t.alike(ix.gardenStreet(O, keys, { visible: (key) => key !== k(0) }).rows[0].key, k(1), 'an invisible key is skipped')
})

test('gardenStreet: paging across the key budget never dead ends', (t) => {
  const ix = createEngagementIndex()
  const total = 2 * GARDEN_STREET_SCAN + 500
  const keys = []
  for (let i = 0; i < total; i++) keys.push(k(i))
  const onAt = [10, GARDEN_STREET_SCAN + 500, 2 * GARDEN_STREET_SCAN + 400]
  for (const i of onAt) t.ok(add(ix, k(i), 1, gardenRecord({ on: true, at: iso(NOW) })))
  t.ok(add(ix, k(20), 1, gardenRecord({ on: false, at: iso(NOW) })))
  const got = []
  const cursors = []
  let cursor = null
  for (let call = 0; call < 10; call++) {
    const res = ix.gardenStreet(O, keys, { cursor })
    got.push(...res.rows.map((r) => r.key))
    cursors.push(res.next)
    if (res.next === null) break
    t.ok(cursor === null || res.next > cursor, 'the cursor always advances')
    cursor = res.next
  }
  t.alike(got, onAt.map(k), 'every on balcony is found, the off one never')
  t.alike(cursors, [k(GARDEN_STREET_SCAN - 1), k(2 * GARDEN_STREET_SCAN - 1), null], 'each call spends the whole budget')
  const empty = ix.gardenStreet(O, keys.slice(0, GARDEN_STREET_SCAN))
  t.alike(empty, { rows: [{ key: k(10), on: 1, state: null }], next: null }, 'exactly the budget with nothing left ends the walk')
})

// The street cursor is public: a key the follows index hides must never be
// `next`, or paging /rua would reveal that follow edge.
test('gardenStreet: a key visible refuses is never listed, never next and costs no budget', (t) => {
  const ix = createEngagementIndex()
  const total = GARDEN_STREET_SCAN + 100
  const keys = []
  for (let i = 0; i < total; i++) keys.push(k(i))
  const refused = new Set([1997, 1998, 1999, 2000, 2001, 2002, 2003].map(k))
  // A few on balconies, refused ones among them; the rest are closed, so
  // the key budget, not the page, ends a call.
  const onAt = [5, 1998, 1999, 2004, 2050]
  for (const i of onAt) t.ok(add(ix, k(i), 1, gardenRecord({ on: true, at: iso(NOW) })))
  const calls = new Map()
  const visible = (key) => {
    calls.set(key, (calls.get(key) || 0) + 1)
    return !refused.has(key)
  }
  const got = []
  const cursors = []
  let cursor = null
  for (let call = 0; call < 10; call++) {
    const res = ix.gardenStreet(O, keys, { cursor, visible })
    got.push(...res.rows.map((r) => r.key))
    cursors.push(res.next)
    if (res.next === null) break
    t.absent(refused.has(res.next), 'next is never a refused key')
    cursor = res.next
  }
  t.is(cursors.at(-1), null, 'the walk terminates')
  t.alike(cursors, [k(GARDEN_STREET_SCAN + 6), null], 'only visible keys count toward the budget')
  t.alike(got, [5, 2004, 2050].map(k), 'every visible on balcony once, the refused ones never')
  t.ok(keys.every((key) => calls.get(key) === 1), 'every key examined exactly once across the walk')

  const allOn = createEngagementIndex()
  for (const key of keys) t.ok(add(allOn, key, 1, gardenRecord({ on: true, at: iso(NOW) })))
  const seen = []
  cursor = null
  for (let call = 0; call < 200; call++) {
    const res = allOn.gardenStreet(O, keys, { cursor, visible: (key) => !refused.has(key) })
    seen.push(...res.rows.map((r) => r.key))
    if (res.next === null) break
    t.absent(refused.has(res.next), 'next is never a refused key')
    cursor = res.next
  }
  t.alike(seen, keys.filter((key) => !refused.has(key)), 'opted in everywhere: every visible key listed once, in order')
})

test('gardenStreet: a tail of refused keys after the last visible one ends the walk', (t) => {
  const ix = createEngagementIndex()
  const keys = []
  for (let i = 0; i < GARDEN_STREET_SCAN + 50; i++) keys.push(k(i))
  const visible = (key) => key <= k(GARDEN_STREET_SCAN - 1)
  const first = ix.gardenStreet(O, keys, { visible })
  t.is(first.next, k(GARDEN_STREET_SCAN - 1), 'the budget ends on the last visible key')
  t.alike(ix.gardenStreet(O, keys, { visible, cursor: first.next }), { rows: [], next: null }, 'only refused keys remain')
  t.alike(ix.gardenStreet(O, [k(1), k(2)], { visible: (key) => key === k(1) }), { rows: [], next: null })
})

test('gardenStreet: visible is asked for a closed or off balcony too', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, k(2), 1, gardenRecord({ on: false, at: iso(NOW) })))
  let calls = 0
  const res = ix.gardenStreet(O, [k(1), k(2)], { visible: () => { calls++; return true } })
  t.alike(res, { rows: [], next: null })
  t.is(calls, 2, 'one call per key, closed or off')
})
