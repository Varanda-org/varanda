import test from 'brittle'
import { CONSENT_LINES, OFF_CONFIRM_TEXT, rowsOf, stateOn, viewOf, visitasAvailable } from '../src/visitasView.js'

const K = 'a'.repeat(64)
const NOW = new Date(2026, 10, 16, 12).getTime()
const DAY = 86400000

test('available only hosted and unlocked', (t) => {
  t.ok(visitasAvailable({ hosted: true, unlocked: true }))
  t.absent(visitasAvailable({ hosted: true, unlocked: false }))
  t.absent(visitasAvailable({ hosted: false, unlocked: true }))
  t.absent(visitasAvailable({}))
})

test('rowsOf keeps only well-formed rows', (t) => {
  t.alike(rowsOf({ visits: [{ key: K, at: 5 }, { key: 'x', at: 5 }, { key: K, at: 'n' }, null] }), [{ key: K, at: 5 }])
  t.alike(rowsOf(null), [])
  t.alike(rowsOf({ visits: 'no' }), [])
})

test('stateOn', (t) => {
  t.ok(stateOn({ on: true }))
  t.absent(stateOn({ on: false }))
  t.absent(stateOn(null))
})

test('viewOf groups by day, newest first, with notices', (t) => {
  const list = { visits: [{ key: K, at: NOW - DAY }, { key: 'b'.repeat(64), at: NOW }] }
  const v = viewOf({ list, state: { on: true, sentToday: 10 }, now: NOW, dmsOn: false })
  t.alike(v.groups.map((g) => g.label), ['hoje', 'ontem'])
  t.is(v.notices.length, 2)
  t.absent(v.empty)
  t.absent(v.off)
})

test('viewOf empty and off states', (t) => {
  t.ok(viewOf({ list: { visits: [] }, state: { on: true, sentToday: 0 }, now: NOW, dmsOn: true }).empty)
  const off = viewOf({ list: { visits: [] }, state: { on: false, sentToday: 0 }, now: NOW, dmsOn: true })
  t.ok(off.off)
  t.absent(off.empty)
  t.absent(viewOf({ list: null, state: null, now: NOW, dmsOn: true }).off, 'unknown state is not off')
})

test('copy says what is sent and that the list is erased', (t) => {
  t.ok(CONSENT_LINES.length === 3)
  t.ok(OFF_CONFIRM_TEXT.includes('apagada'))
  t.absent([...CONSENT_LINES, OFF_CONFIRM_TEXT].join('').includes('\u2014'))
})
