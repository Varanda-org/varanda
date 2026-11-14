'use strict'

// The older-page trigger (src/olderTrigger.js), an ES module loaded through
// import() as in format.test.js.
const test = require('brittle')

const load = () => import('../src/olderTrigger.js')
const base = { y: 50, userScrolled: true, hasNext: true, loading: false, failed: false }

test('initial layout without a user scroll never loads', async (t) => {
  const { olderInitial, olderStep } = await load()
  const r = olderStep(olderInitial(), { ...base, userScrolled: false })
  t.is(r.load, false)
  t.is(olderStep(r.state, base).load, true)
})

test('repeat frames inside the zone load once per entry', async (t) => {
  const { olderInitial, olderStep } = await load()
  let s = olderInitial()
  const loads = []
  for (const y of [150, 120, 90, 60, 199]) {
    const r = olderStep(s, { ...base, y })
    s = r.state
    loads.push(r.load)
  }
  t.alike(loads, [true, false, false, false, false])
})

test('failed never loads, and a cleared error re-arms only after leaving the zone', async (t) => {
  const { olderInitial, olderStep } = await load()
  let r = olderStep(olderInitial(), { ...base, failed: true })
  t.is(r.load, false)
  r = olderStep(r.state, { ...base, failed: true })
  t.is(r.load, false)
  r = olderStep(r.state, base)
  t.is(r.load, false)
  r = olderStep(r.state, { ...base, y: 600 })
  t.is(r.load, false)
  r = olderStep(r.state, base)
  t.is(r.load, true)
})

test('re-arms only after y leaves the 200 pt zone', async (t) => {
  const { olderInitial, olderStep } = await load()
  let r = olderStep(olderInitial(), base)
  t.is(r.load, true)
  r = olderStep(r.state, { ...base, y: 200 })
  t.is(r.load, false)
  r = olderStep(r.state, { ...base, y: 201 })
  t.is(r.load, false)
  r = olderStep(r.state, { ...base, y: 0 })
  t.is(r.load, true)
})

test('never loads while loading or without hasNext', async (t) => {
  const { olderInitial, olderStep } = await load()
  t.is(olderStep(olderInitial(), { ...base, loading: true }).load, false)
  t.is(olderStep(olderInitial(), { ...base, hasNext: false }).load, false)
  const r = olderStep(olderInitial(), { ...base, loading: true })
  t.is(olderStep(r.state, base).load, true)
})
