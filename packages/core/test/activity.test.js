'use strict'

// lib/activity.js: Brasília day boundaries (fixed UTC-3), growth noted only
// over a safe-integer baseline, the day and week windows at their exact
// edges, only gated entries with an activeAt counted, counts-only output,
// and that the module requires nothing.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const {
  DAY_MS,
  WEEK_DAYS,
  DAY_OFFSET_MS,
  dayStart,
  localDay,
  noteGrowth,
  countActive
} = require('../lib/activity')

const ms = (iso) => Date.parse(iso)

test('constants', (t) => {
  t.is(DAY_MS, 86400000)
  t.is(WEEK_DAYS, 7)
  t.is(DAY_OFFSET_MS, -3 * 3600000)
})

test('dayStart: 00:00 Brasília of the containing day', (t) => {
  t.is(dayStart(ms('2026-10-27T02:59:59.999Z')), ms('2026-10-26T03:00:00.000Z'), 'just before Brasília midnight')
  t.is(dayStart(ms('2026-10-27T03:00:00.000Z')), ms('2026-10-27T03:00:00.000Z'), 'exact Brasília midnight')
  t.is(dayStart(ms('2026-10-27T15:30:00.000Z')), ms('2026-10-27T03:00:00.000Z'), 'mid-day')
  t.is(dayStart(ms('2026-10-27T00:00:00.000Z')), ms('2026-10-26T03:00:00.000Z'), 'UTC midnight is still the previous day')
  t.is(dayStart(0), ms('1969-12-31T03:00:00.000Z'), 'before the epoch day start')
})

test('localDay: Brasília calendar day', (t) => {
  t.is(localDay(ms('2026-10-27T02:00:00Z')), '2026-10-26')
  t.is(localDay(ms('2026-10-27T03:00:00Z')), '2026-10-27')
  t.is(localDay(ms('2026-10-27T02:59:59.999Z')), '2026-10-26')
})

test('noteGrowth: no change unless strictly larger over a baseline', (t) => {
  const cases = [
    ['equal', { activityLength: 3, activeAt: null }, 3],
    ['smaller', { activityLength: 3, activeAt: null }, 2],
    ['NaN', { activityLength: 3, activeAt: null }, NaN],
    ['fraction', { activityLength: 3, activeAt: null }, 1.5],
    ['fraction above', { activityLength: 3, activeAt: null }, 3.5],
    ['missing baseline', { activeAt: null }, 4],
    ['null baseline', { activityLength: null, activeAt: null }, 4]
  ]
  for (const [name, entry, length] of cases) {
    const before = JSON.stringify(entry)
    t.is(noteGrowth(entry, length, 1000), false, name)
    t.is(JSON.stringify(entry), before, name + ' unchanged')
  }
})

test('noteGrowth: growth sets both fields', (t) => {
  const entry = { activityLength: 3, activeAt: null }
  t.is(noteGrowth(entry, 5, 1234), true)
  t.is(entry.activityLength, 5)
  t.is(entry.activeAt, 1234)
  t.is(noteGrowth(entry, 5, 9999), false, 'same length again')
  t.is(entry.activeAt, 1234)
})

test('countActive: window edges at 00:00 Brasília', (t) => {
  const now = ms('2026-10-27T15:00:00.000Z')
  const today = ms('2026-10-27T03:00:00.000Z')
  const weekStart = today - 6 * DAY_MS
  t.is(weekStart, ms('2026-10-21T03:00:00.000Z'))
  const at = (activeAt) => countActive([{ gated: true, activeAt }], now)
  t.alike(at(today), { activeDay: 1, activeWeek: 1 }, 'exactly today 00:00:00.000 counts in both')
  t.alike(at(today - 1), { activeDay: 0, activeWeek: 1 }, '1 ms earlier counts in the week only')
  t.alike(at(weekStart), { activeDay: 0, activeWeek: 1 }, 'exactly weekStart counts in the week')
  t.alike(at(weekStart - 1), { activeDay: 0, activeWeek: 0 }, 'weekStart - 1 counts in neither')
  t.alike(at(now + DAY_MS), { activeDay: 1, activeWeek: 1 }, 'a future activeAt counts in both')
})

test('countActive: skips ungated and inactive entries, counts only', (t) => {
  const now = ms('2026-10-27T15:00:00.000Z')
  const entries = new Map([
    ['a', { gated: true, activeAt: now - 1000 }],
    ['b', { gated: false, activeAt: now - 1000 }],
    ['c', { gated: true, activeAt: null }],
    ['d', { gated: true, activeAt: now - 3 * DAY_MS }],
    ['e', { activeAt: now }]
  ])
  const result = countActive(entries.values(), now)
  t.alike(Object.keys(result), ['activeDay', 'activeWeek'])
  t.alike(result, { activeDay: 1, activeWeek: 2 })
  t.alike(countActive([], now), { activeDay: 0, activeWeek: 0 })
})

test('module requires nothing', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'activity.js'), 'utf8')
  t.absent(/\brequire\s*\(/.test(src))
})
