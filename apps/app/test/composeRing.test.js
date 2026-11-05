'use strict'

// The composer ring tones (src/composeRing.js, an ES module).
const test = require('brittle')

const load = () => import('../src/composeRing.js')

test('tone and remaining across the thresholds', async (t) => {
  const { ringState } = await load()
  t.alike(ringState(0, 1000), { progress: 0, tone: 'accent', remaining: null })
  t.alike(ringState(899, 1000), { progress: 0.899, tone: 'accent', remaining: null })
  t.alike(ringState(900, 1000), { progress: 0.9, tone: 'warn', remaining: 100 })
  t.alike(ringState(1000, 1000), { progress: 1, tone: 'warn', remaining: 0 })
  t.alike(ringState(1001, 1000), { progress: 1, tone: 'danger', remaining: -1 })
})

test('bad inputs count as an empty draft', async (t) => {
  const { ringState } = await load()
  for (const bad of [NaN, -5, Infinity, undefined, null, '12']) {
    t.alike(ringState(bad, 1000), { progress: 0, tone: 'accent', remaining: null })
  }
})
