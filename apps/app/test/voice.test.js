'use strict'

// Voice note recording rules (src/media/voice.js).
const test = require('brittle')

const load = () => import('../src/media/voice.js')

test('recordPlan: a slip is dropped, past two minutes is too long', async (t) => {
  const { recordPlan, MIN_RECORD_MS, MAX_RECORD_MS } = await load()
  t.is(MIN_RECORD_MS, 800)
  t.is(MAX_RECORD_MS, 120000)
  t.alike(recordPlan(0), { cancelled: true, tooLong: false })
  t.alike(recordPlan(799), { cancelled: true, tooLong: false })
  t.alike(recordPlan(800), { cancelled: false, tooLong: false })
  t.alike(recordPlan(120000), { cancelled: false, tooLong: false })
  t.alike(recordPlan(120001), { cancelled: false, tooLong: true })
  for (const bad of [NaN, Infinity, -1, undefined, null, '5000']) {
    t.is(recordPlan(bad).cancelled, true, String(bad) + ' is a slip')
  }
})

test('durationLabel: m:ss, seconds rounded down', async (t) => {
  const { durationLabel } = await load()
  t.is(durationLabel(0), '0:00')
  t.is(durationLabel(999), '0:00')
  t.is(durationLabel(3000), '0:03')
  t.is(durationLabel(59999), '0:59')
  t.is(durationLabel(60000), '1:00')
  t.is(durationLabel(119999), '1:59')
  t.is(durationLabel(120000), '2:00')
  t.is(durationLabel(605000), '10:05')
  for (const bad of [NaN, -5000, undefined, null, Infinity]) t.is(durationLabel(bad), '0:00')
})

test('slideToCancel: past 80 px to the left', async (t) => {
  const { slideToCancel, CANCEL_DX } = await load()
  t.is(CANCEL_DX, -80)
  t.is(slideToCancel(0), false)
  t.is(slideToCancel(40), false)
  t.is(slideToCancel(-80), false)
  t.is(slideToCancel(-81), true)
  t.is(slideToCancel(-500), true)
  t.is(slideToCancel(NaN), false)
  t.is(slideToCancel(undefined), false)
})
