'use strict'

// The visit budget and the list of visitors (lib/visits.js). No network.
const test = require('brittle')
const rpc = require('@varanda/rpc')
const visits = require('../lib/visits')

const {
  VISIT_DAILY_MAX, VISIT_PROFILE_DAYS, VISIT_STAMP_RESERVE, VISIT_LIST_MAX, VISIT_KEEP_DAYS, VISIT_DAY_SLACK,
  isVisitDay, visitDay, dayNumber, dayMs, visitDayFresh, sentToday, canVisit, pruneSent, listVisits
} = visits

function k (i) {
  return i.toString(16).padStart(64, '0')
}

const ME = k(1)
const ANA = k(2)
const BIA = k(3)
const DAY_MS = 86400000
// 2026-11-16 at 23:30 UTC: late in the day, so a local evening is still today.
const NOW = Date.UTC(2026, 10, 16, 23, 30)
const TODAY = '2026-11-16'

// The day n days before NOW (n < 0 is a day still to come).
function ago (n) {
  return visitDay(NOW - n * DAY_MS)
}

const STAMPS = VISIT_STAMP_RESERVE + 1

test('constants match the rpc limits', (t) => {
  t.ok(Object.isFrozen(visits))
  t.is(VISIT_DAILY_MAX, rpc.VISIT_DAILY_MAX)
  t.is(VISIT_PROFILE_DAYS, rpc.VISIT_PROFILE_DAYS)
  t.is(VISIT_STAMP_RESERVE, rpc.VISIT_STAMP_RESERVE)
  t.is(VISIT_LIST_MAX, rpc.VISIT_LIST_MAX)
  t.is(VISIT_KEEP_DAYS, rpc.VISIT_KEEP_DAYS)
  t.alike([VISIT_DAILY_MAX, VISIT_PROFILE_DAYS, VISIT_STAMP_RESERVE, VISIT_LIST_MAX, VISIT_KEEP_DAYS, VISIT_DAY_SLACK], [10, 7, 5, 50, 30, 1])
})

test('day precision: canonical UTC dates only', (t) => {
  t.is(visitDay(NOW), TODAY)
  t.is(visitDay(Date.UTC(2026, 10, 17, 0, 0)), '2026-11-17', 'midnight UTC starts the next day')
  t.is(visitDay(0), '1970-01-01')
  for (const bad of [NaN, Infinity, '1', null, undefined, 8.64e15 + 1]) {
    t.exception.all(() => visitDay(bad), /data inválida/, 'visitDay ' + String(bad))
  }
  for (const ok of ['2026-11-16', '2024-02-29', '1970-01-01', '0001-01-01']) t.ok(isVisitDay(ok), ok)
  for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-6', '2026-11-16T00:00:00.000Z', '2026-11-16 ', '+2026-11-16', '2026/11/16', '', 20261116, null, undefined, {}, ['2026-11-16']]) {
    t.absent(isVisitDay(bad), 'day ' + JSON.stringify(bad))
  }
  t.is(dayNumber('1970-01-02'), 1)
  t.is(dayNumber(TODAY) - dayNumber('2026-11-09'), 7)
  t.ok(Number.isNaN(dayNumber('2026-02-30')))
  t.is(dayMs(TODAY), Date.UTC(2026, 10, 16))
  t.ok(Number.isNaN(dayMs('nope')))
})

test('a received ping names today, give or take one day', (t) => {
  t.ok(visitDayFresh(TODAY, NOW))
  t.ok(visitDayFresh(ago(1), NOW), 'yesterday')
  t.ok(visitDayFresh(ago(-1), NOW), 'tomorrow')
  t.absent(visitDayFresh(ago(2), NOW), 'two days old')
  t.absent(visitDayFresh(ago(-2), NOW), 'two days ahead')
  t.absent(visitDayFresh('2026-02-30', NOW))
  t.absent(visitDayFresh(TODAY, NaN), 'no clock, no visit')
  t.absent(visitDayFresh(TODAY, 'now'))
})

test('canVisit: the daily cap', (t) => {
  const sent = []
  for (let i = 0; i < VISIT_DAILY_MAX - 1; i++) sent.push({ to: k(100 + i), day: TODAY })
  t.alike(canVisit({ self: ME, to: ANA, sent, stamps: STAMPS, now: NOW }), { ok: true }, 'one below the cap')
  sent.push({ to: k(200), day: TODAY })
  t.is(sentToday(sent, NOW), VISIT_DAILY_MAX)
  t.alike(canVisit({ self: ME, to: ANA, sent, stamps: 1000, now: NOW }), { ok: false, reason: 'daily' }, 'at the cap')
  t.alike(canVisit({ self: ME, to: ANA, sent, stamps: STAMPS, now: NOW + DAY_MS }), { ok: true }, 'the next UTC day starts over')

  // Turning the clock back never frees the budget: a row dated after today counts as today.
  const ahead = sent.map(r => ({ ...r, day: ago(-1) }))
  t.is(sentToday(ahead, NOW), VISIT_DAILY_MAX)
  t.alike(canVisit({ self: ME, to: ANA, sent: ahead, stamps: STAMPS, now: NOW }), { ok: false, reason: 'daily' })

  // Yesterday's pings do not count today.
  const yesterday = sent.map(r => ({ ...r, day: ago(1) }))
  t.is(sentToday(yesterday, NOW), 0)
  // Malformed rows are not pings.
  t.is(sentToday([null, 1, { to: ANA }, { day: TODAY }, { to: 'x', day: TODAY }, { to: ANA, day: '2026-02-30' }], NOW), 0)
  t.is(sentToday(null, NOW), 0)
})

test('canVisit: one ping per profile per window', (t) => {
  const go = (day, now = NOW) => canVisit({ self: ME, to: ANA, sent: [{ to: ANA, day }], stamps: STAMPS, now })
  t.alike(go(TODAY), { ok: false, reason: 'recent' })
  t.alike(go(ago(VISIT_PROFILE_DAYS - 1)), { ok: false, reason: 'recent' }, 'the last day of the window')
  t.alike(go(ago(VISIT_PROFILE_DAYS)), { ok: true }, 'the window is over')
  t.alike(go(ago(-3)), { ok: false, reason: 'recent' }, 'a ping dated in the future still counts')
  t.alike(canVisit({ self: ME, to: BIA, sent: [{ to: ANA, day: TODAY }], stamps: STAMPS, now: NOW }), { ok: true }, 'another profile')
})

test('canVisit: the stamp reserve', (t) => {
  const go = (stamps) => canVisit({ self: ME, to: ANA, sent: [], stamps, now: NOW })
  t.alike(go(VISIT_STAMP_RESERVE + 1), { ok: true }, 'spending one leaves the reserve')
  t.alike(go(VISIT_STAMP_RESERVE), { ok: false, reason: 'stamps' }, 'never the reserve itself')
  t.alike(go(0), { ok: false, reason: 'stamps' })
  for (const bad of [undefined, null, '20', 6.5, NaN, Infinity, -1]) {
    t.alike(go(bad), { ok: false, reason: 'stamps' }, 'stamps ' + String(bad))
  }
})

test('canVisit: bad input is refused', (t) => {
  t.alike(canVisit({ self: ME, to: ME, sent: [], stamps: STAMPS, now: NOW }), { ok: false, reason: 'self' })
  t.alike(canVisit({ self: ME, to: 'nope', sent: [], stamps: STAMPS, now: NOW }), { ok: false, reason: 'invalid' })
  t.alike(canVisit({ self: 'nope', to: ANA, sent: [], stamps: STAMPS, now: NOW }), { ok: false, reason: 'invalid' })
  for (const now of [NaN, undefined, '1', 8.64e15 + 1]) {
    t.alike(canVisit({ self: ME, to: ANA, sent: [], stamps: STAMPS, now }), { ok: false, reason: 'invalid' }, 'now ' + String(now))
  }
  t.alike(canVisit(), { ok: false, reason: 'invalid' })
  t.alike(canVisit({ self: ME, to: ANA, sent: 'x', stamps: STAMPS, now: NOW }), { ok: true }, 'no log is an empty log')
})

test('pruneSent keeps exactly what the budget reads', (t) => {
  const sent = [
    { to: ANA, day: TODAY, extra: 1 },
    { to: BIA, day: ago(VISIT_PROFILE_DAYS - 1) },
    { to: k(9), day: ago(VISIT_PROFILE_DAYS) },
    { to: k(10), day: ago(-1) },
    { to: 'x', day: TODAY },
    null
  ]
  t.alike(pruneSent(sent, NOW), [
    { to: ANA, day: TODAY },
    { to: BIA, day: ago(VISIT_PROFILE_DAYS - 1) },
    { to: k(10), day: ago(-1) }
  ])
  const pruned = pruneSent(sent, NOW)
  t.alike(canVisit({ self: ME, to: BIA, sent: pruned, stamps: STAMPS, now: NOW }), canVisit({ self: ME, to: BIA, sent, stamps: STAMPS, now: NOW }), 'pruning changes no answer')
  t.is(pruneSent(sent, NaN).length, 4, 'a bad clock prunes nothing valid')
})

test('listVisits: one row per visitor, newest first', (t) => {
  const rows = [
    { from: ANA, day: ago(5), at: 'x', text: 'secret' },
    { from: ANA, day: ago(1) },
    { from: ANA, day: ago(3) },
    { from: BIA, day: ago(1) },
    { from: k(4), day: TODAY }
  ]
  t.alike(listVisits(rows, NOW), [
    { from: k(4), day: TODAY },
    { from: ANA, day: ago(1) },
    { from: BIA, day: ago(1) }
  ], 'ties by key, every other field dropped')
  t.alike(listVisits([...rows].reverse(), NOW), listVisits(rows, NOW), 'input order never decides')
})

test('listVisits: expiry, future days and exclusions', (t) => {
  const rows = [
    { from: ANA, day: ago(VISIT_KEEP_DAYS - 1) },
    { from: BIA, day: ago(VISIT_KEEP_DAYS) },
    { from: k(4), day: ago(-VISIT_DAY_SLACK) },
    { from: k(5), day: ago(-VISIT_DAY_SLACK - 1) },
    { from: ME, day: TODAY },
    { from: k(6), day: TODAY },
    { from: 'nope', day: TODAY },
    { from: k(7), day: '2026-02-30' },
    null,
    7
  ]
  t.alike(listVisits(rows, NOW, { self: ME, blocked: new Set([k(6)]) }), [
    { from: k(4), day: ago(-1) },
    { from: ANA, day: ago(VISIT_KEEP_DAYS - 1) }
  ], 'kept for VISIT_KEEP_DAYS days; no self, no blocked, nothing malformed')
  t.alike(listVisits(rows, NOW, { self: ME, blocked: [k(6)] }), listVisits(rows, NOW, { self: ME, blocked: new Set([k(6)]) }), 'blocked as an array')
  // An older day of a visitor whose newest day is too far ahead still counts.
  t.alike(listVisits([{ from: ANA, day: ago(-5) }, { from: ANA, day: ago(2) }], NOW), [{ from: ANA, day: ago(2) }])
  t.alike(listVisits(rows, NaN), [], 'no clock, no list')
  t.alike(listVisits(null, NOW), [])
  t.is(listVisits(rows, NOW, null).length, 4, 'null opts exclude nothing')
})

test('listVisits: at most VISIT_LIST_MAX rows, the newest', (t) => {
  const rows = []
  for (let i = 0; i < VISIT_LIST_MAX + 10; i++) rows.push({ from: k(100 + i), day: ago(i % VISIT_KEEP_DAYS) })
  const list = listVisits(rows, NOW)
  t.is(list.length, VISIT_LIST_MAX)
  const oldestKept = dayNumber(list[list.length - 1].day)
  const dropped = rows.filter(r => !list.some(l => l.from === r.from))
  t.is(dropped.length, 10)
  t.ok(dropped.every(r => dayNumber(r.day) <= oldestKept), 'only the oldest fall off')
  for (let i = 1; i < list.length; i++) t.ok(dayNumber(list[i - 1].day) >= dayNumber(list[i].day))
})

test('listVisits: a day ahead ranks as today, after genuine visits, for the cap', (t) => {
  const rows = []
  for (let i = 0; i < VISIT_LIST_MAX; i++) rows.push({ from: k(200 + i), day: TODAY })
  // Lower keys than every genuine row, so a key tie-break alone would keep them.
  for (let i = 0; i < 5; i++) rows.push({ from: k(10 + i), day: ago(-VISIT_DAY_SLACK) })
  rows.push({ from: k(20), day: ago(1) })
  const list = listVisits(rows, NOW)
  t.is(list.length, VISIT_LIST_MAX)
  t.ok(list.every(r => r.day === TODAY), 'the genuine visits of today fill the cap')
  t.absent(list.some(r => r.from === k(10)), 'a ping dated ahead does not push a genuine visit out')
  const few = listVisits([{ from: k(10), day: ago(-1) }, { from: k(30), day: TODAY }, { from: k(31), day: ago(1) }], NOW)
  t.alike(few, [{ from: k(30), day: TODAY }, { from: k(10), day: ago(-1) }, { from: k(31), day: ago(1) }], 'it ranks as today and keeps its own day')
})
