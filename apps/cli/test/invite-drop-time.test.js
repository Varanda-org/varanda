'use strict'

// apps/cli/lib/account/invite-drop-time.js: the pure Brasília schedule of
// surprise invite drops. No network, no fs; every instant is a literal.

const test = require('brittle')
const {
  WINDOW_START_MIN, WINDOW_END_MIN, weekStartMs, inWindow, windowEndMs,
  eligibleMinutes, grantMinutes, grantsOpened
} = require('../lib/account/invite-drop-time')

const MIN = 60000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Monday 2026-11-02 00:00 Brasília.
const MONDAY = Date.parse('2026-11-02T03:00:00.000Z')
const ZERO = Buffer.alloc(32)
const MEMBER = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

function brasiliaMinute (ms) {
  const d = new Date(ms - 3 * HOUR)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

test('window constants', (t) => {
  t.is(WINDOW_START_MIN, 540)
  t.is(WINDOW_END_MIN, 1260)
})

test('weekStartMs is Monday 00:00 Brasília', (t) => {
  t.is(weekStartMs(MONDAY), MONDAY)
  t.is(weekStartMs(MONDAY + 6 * DAY + 23 * HOUR + 59 * MIN), MONDAY)
  t.is(weekStartMs(MONDAY - 1), MONDAY - 7 * DAY)
  // Sunday 23:00 Brasília is already Monday in UTC.
  t.is(weekStartMs(Date.parse('2026-11-09T02:00:00.000Z')), MONDAY)
})

test('inWindow boundaries', (t) => {
  t.absent(inWindow(MONDAY + 8 * HOUR + 59 * MIN + 59999))
  t.ok(inWindow(MONDAY + 9 * HOUR))
  t.ok(inWindow(MONDAY + 20 * HOUR + 59 * MIN))
  t.ok(inWindow(MONDAY + 20 * HOUR + 59 * MIN + 59999))
  t.absent(inWindow(MONDAY + 21 * HOUR))
  t.absent(inWindow(MONDAY))
})

test('windowEndMs is 21:00 Brasília of the same day', (t) => {
  const end = MONDAY + 21 * HOUR
  t.is(windowEndMs(MONDAY), end)
  t.is(windowEndMs(MONDAY + 10 * HOUR), end)
  t.is(windowEndMs(end - 1), end)
  t.is(windowEndMs(MONDAY + DAY - 1), end)
  t.is(windowEndMs(MONDAY + DAY), end + DAY)
})

test('eligibleMinutes covers 09:00 to 20:59 of every day', (t) => {
  const all = eligibleMinutes({ weekStartMs: MONDAY })
  t.is(all.length, 7 * 720)
  t.is(all[0], MONDAY + 9 * HOUR)
  t.is(all[719], MONDAY + 20 * HOUR + 59 * MIN)
  t.is(all[720], MONDAY + DAY + 9 * HOUR)
  t.ok(all.every((m, i) => i === 0 || m > all[i - 1]), 'ascending')
  t.ok(all.every((m) => m % MIN === 0 && inWindow(m)))
  t.ok(all.includes(MONDAY + 20 * HOUR + 59 * MIN), '20:59 included')
  t.absent(all.includes(MONDAY + 21 * HOUR), '21:00 excluded')
})

test('mid-week linkedAt and enabledAt shrink the set', (t) => {
  const wedNoon = MONDAY + 2 * DAY + 12 * HOUR
  const byLink = eligibleMinutes({ weekStartMs: MONDAY, linkedAtMs: wedNoon })
  t.is(byLink[0], wedNoon)
  t.is(byLink.length, 720 * 5 - 180)
  const byEnable = eligibleMinutes({ weekStartMs: MONDAY, linkedAtMs: MONDAY, enabledAtMs: wedNoon + 30 * 1000 })
  t.is(byEnable[0], wedNoon + MIN, 'a mid-minute instant excludes that minute')
  t.is(byEnable.length, byLink.length - 1)
  const both = eligibleMinutes({ weekStartMs: MONDAY, linkedAtMs: wedNoon + HOUR, enabledAtMs: wedNoon })
  t.is(both[0], wedNoon + HOUR)
})

test('empty set after Sunday 21:00', (t) => {
  const sunEnd = MONDAY + 6 * DAY + 21 * HOUR
  t.is(eligibleMinutes({ weekStartMs: MONDAY, linkedAtMs: sunEnd }).length, 0)
  t.is(eligibleMinutes({ weekStartMs: MONDAY, enabledAtMs: sunEnd - MIN }).length, 1)
  const g = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 2, linkedAtMs: sunEnd })
  t.alike(g, [null, null])
  t.is(grantsOpened(g, sunEnd + DAY), 0)
})

test('hardcoded vector', (t) => {
  const g = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 3 })
  t.alike(g.map((m) => new Date(m).toISOString()), [
    '2026-11-02T15:06:00.000Z',
    '2026-11-02T19:41:00.000Z',
    '2026-11-03T16:02:00.000Z'
  ])
})

test('same inputs give the same output', (t) => {
  const a = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 5 })
  const b = grantMinutes({ secret: Buffer.alloc(32), member: MEMBER, weekStartMs: MONDAY, perWeek: 5 })
  t.alike(a, b)
})

test('two members differ, two secrets differ, two weeks differ', (t) => {
  const base = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 3 })
  const other = grantMinutes({ secret: ZERO, member: OTHER, weekStartMs: MONDAY, perWeek: 3 })
  const secret = Buffer.alloc(32, 1)
  const otherSecret = grantMinutes({ secret, member: MEMBER, weekStartMs: MONDAY, perWeek: 3 })
  const nextWeek = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY + 7 * DAY, perWeek: 3 })
  t.unlike(base, other)
  t.unlike(base, otherSecret)
  t.unlike(base.map((m) => m - MONDAY), nextWeek.map((m) => m - MONDAY - 7 * DAY))
})

test('every drawn minute is inside 09:00 to 20:59 Brasília of its week', (t) => {
  let ok = true
  for (let w = 0; w < 8; w++) {
    const week = MONDAY + w * 7 * DAY
    for (let i = 0; i < 8; i++) {
      const member = (i.toString(16) + 'f').repeat(32)
      for (const m of grantMinutes({ secret: ZERO, member, weekStartMs: week, perWeek: 10 })) {
        const mod = brasiliaMinute(m)
        if (m === null || m % MIN !== 0 || m < week || m >= week + 7 * DAY || mod < 540 || mod > 1259) ok = false
      }
    }
  }
  t.ok(ok)
})

test('drawn minutes respect linkedAt and enabledAt', (t) => {
  const wedNoon = MONDAY + 2 * DAY + 12 * HOUR
  const g = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 20, linkedAtMs: wedNoon, enabledAtMs: wedNoon + 1 })
  t.ok(g.every((m) => m !== null && m >= wedNoon + MIN))
})

test('perWeek 1 and 3 give distinct minutes', (t) => {
  const one = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 1 })
  t.is(one.length, 1)
  t.ok(one[0] !== null)
  const three = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 3 })
  t.is(three.length, 3)
  t.is(new Set(three).size, 3)
  t.is(three[0], one[0], 'slot 0 does not depend on perWeek')
})

test('perWeek 100 with exactly 100 eligible minutes fills every one', (t) => {
  const from = MONDAY + 6 * DAY + 21 * HOUR - 100 * MIN
  t.is(eligibleMinutes({ weekStartMs: MONDAY, linkedAtMs: from }).length, 100)
  const g = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 100, linkedAtMs: from })
  t.is(g.length, 100)
  t.ok(g.every((m) => m !== null && m >= from))
  t.is(new Set(g).size, 100)
})

test('perWeek 3 with 2 eligible minutes leaves only the last slot null', (t) => {
  const from = MONDAY + 6 * DAY + 21 * HOUR - 2 * MIN
  const g = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 3, linkedAtMs: from })
  t.is(g[2], null)
  t.ok(g[0] !== null && g[1] !== null)
  t.is(new Set(g.slice(0, 2)).size, 2)
})

test('grantsOpened counts non-null minutes at or before now', (t) => {
  const c = { t: MONDAY, now: () => c.t }
  const g = grantMinutes({ secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 3 })
  const sorted = [...g].sort((a, b) => a - b)
  t.is(grantsOpened(g, c.now()), 0)
  c.t = sorted[0] - 1
  t.is(grantsOpened(g, c.now()), 0)
  c.t = sorted[0]
  t.is(grantsOpened(g, c.now()), 1)
  c.t = sorted[1]
  t.is(grantsOpened(g, c.now()), 2)
  c.t = MONDAY + 7 * DAY
  t.is(grantsOpened(g, c.now()), 3)
  t.is(grantsOpened([null, MONDAY], MONDAY), 1)
})

test('grantMinutes rejects bad input', (t) => {
  const ok = { secret: ZERO, member: MEMBER, weekStartMs: MONDAY, perWeek: 1 }
  const bad = [
    { secret: Buffer.alloc(31) },
    { secret: Buffer.alloc(33) },
    { secret: 'x'.repeat(32) },
    { secret: new Uint8Array(32) },
    { member: 'AB'.repeat(32) },
    { member: 'ab'.repeat(31) },
    { member: 42 },
    { perWeek: 0 },
    { perWeek: 101 },
    { perWeek: 1.5 },
    { perWeek: '3' },
    { weekStartMs: 'monday' },
    { linkedAtMs: NaN }
  ]
  for (const b of bad) {
    t.exception.all(() => grantMinutes({ ...ok, ...b }), TypeError)
  }
  t.exception.all(() => grantMinutes(), TypeError)
})
