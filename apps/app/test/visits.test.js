'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const NOW = new Date(2026, 10, 16, 15, 0, 0).getTime()
const at = (m, d, h = 12, y = 2026) => new Date(y, m, d, h).getTime()

test('dayLabel says hoje, ontem and a date', async (t) => {
  const { dayLabel } = await import('../src/visits.js')
  t.is(dayLabel(at(10, 16, 1), NOW), 'hoje')
  t.is(dayLabel(at(10, 15, 23), NOW), 'ontem')
  t.is(dayLabel(at(9, 12), NOW), '12 out')
  t.is(dayLabel(at(11, 30, 12, 2025), NOW), '30 dez 2025')
})

test('groupByDay groups newest first and caps the list', async (t) => {
  const { groupByDay, VISIT_LIST_MAX } = await import('../src/visits.js')
  const g = groupByDay([{ at: Date.UTC(2026, 10, 15, 12), id: 'b' }, { at: Date.UTC(2026, 10, 16, 9), id: 'a' }, { at: Date.UTC(2026, 10, 16, 8), id: 'c' }, { at: NaN }, null], NOW)
  t.alike(g.map((x) => [x.label, x.rows.map((r) => r.id)]), [['hoje', ['a', 'c']], ['ontem', ['b']]])
  const many = Array.from({ length: 80 }, (_, i) => ({ at: NOW - i * 1000 }))
  t.is(groupByDay(many, NOW)[0].rows.length, VISIT_LIST_MAX)
  t.alike(groupByDay(null, NOW), [])
})

test('consent sheet starts off and ignores toggles while busy', async (t) => {
  const { initialConsent, openConsent, toggleConsent, startConsent, closeConsent } = await import('../src/visits.js')
  t.is(initialConsent().visible, false)
  let s = openConsent()
  t.ok(s.open)
  s = toggleConsent(s)
  t.ok(s.visible)
  s = startConsent(s)
  t.is(toggleConsent(s).visible, true, 'busy keeps the choice')
  t.alike(closeConsent(), initialConsent())
})

test('notices for DMs off and the daily limit', async (t) => {
  const { dmsOffNotice, dailyLimitNotice, VISIT_DAILY_MAX } = await import('../src/visits.js')
  t.ok(dmsOffNotice(false))
  t.is(dmsOffNotice(true), null)
  t.is(dailyLimitNotice(VISIT_DAILY_MAX - 1), null)
  t.ok(dailyLimitNotice(VISIT_DAILY_MAX).includes(String(VISIT_DAILY_MAX)))
  t.is(dailyLimitNotice(undefined), null)
})

test('groupByDay reads a UTC visit day as the same calendar day on any clock', async (t) => {
  const { groupByDay, visitLocalMs } = await import('../src/visits.js')
  const day = (d) => Date.UTC(2026, 10, d)
  t.is(visitLocalMs(day(15)), new Date(2026, 10, 15).getTime())
  const g = groupByDay([{ at: day(16), id: 'a' }, { at: day(15), id: 'b' }, { at: day(5), id: 'c' }], NOW)
  t.alike(g.map((x) => [x.label, x.rows.map((r) => r.id)]), [['hoje', ['a']], ['ontem', ['b']], ['5 nov', ['c']]])
})

test('the app visit limits match the @varanda/rpc limits', async (t) => {
  const { VISIT_DAILY_MAX, VISIT_LIST_MAX } = await import('../src/visits.js')
  t.is(VISIT_DAILY_MAX, rpc.VISIT_DAILY_MAX)
  t.is(VISIT_LIST_MAX, rpc.VISIT_LIST_MAX)
})
