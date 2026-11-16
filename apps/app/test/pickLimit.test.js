'use strict'

const test = require('brittle')
const load = () => import('../src/pickLimit.js')

test('pickPlan: no limit keeps the full count and the multi picker', async (t) => {
  const { pickPlan } = await load()
  t.alike(pickPlan(4), { single: false, count: 4 })
  t.alike(pickPlan(4, undefined), { single: false, count: 4 })
})

test('pickPlan: a limit of one asks for the single picker', async (t) => {
  const { pickPlan } = await load()
  t.alike(pickPlan(4, 1), { single: true, count: 1 })
})

test('pickPlan: a bad or larger limit never raises the count', async (t) => {
  const { pickPlan } = await load()
  t.alike(pickPlan(4, 9), { single: false, count: 4 })
  t.alike(pickPlan(4, 0), { single: false, count: 4 })
  t.alike(pickPlan(4, 'x'), { single: false, count: 4 })
  t.alike(pickPlan(4, 2), { single: false, count: 2 })
})
