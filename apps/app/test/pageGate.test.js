'use strict'

const test = require('brittle')

const load = () => import('../src/pageGate.js')

test('hosted is on without an origin, with or without core reach', async (t) => {
  const { pagesOn, pagesCore, setCoreReach } = await load()
  t.teardown(() => setCoreReach(false))
  setCoreReach(false)
  t.is(pagesOn({ hosted: true }), true)
  t.is(pagesOn({ hosted: true, accountOrigin: 'https://varanda.example' }), true)
  setCoreReach(true)
  t.is(pagesOn({ hosted: true }), true)
  t.is(pagesOn({ hosted: true, accountOrigin: undefined }), true)
  t.is(pagesCore({ hosted: true }), false)
})

test('a core node needs an https account origin', async (t) => {
  const { pagesOn, pagesCore, setCoreReach } = await load()
  setCoreReach(true)
  t.teardown(() => setCoreReach(false))
  t.is(pagesOn({ hosted: false, accountOrigin: 'https://varanda.example' }), true)
  t.is(pagesCore({ hosted: false, accountOrigin: 'https://varanda.example' }), true)
  t.is(pagesOn({ hosted: false, accountOrigin: 'http://varanda.example' }), false)
  t.is(pagesOn({ hosted: false, accountOrigin: '' }), false)
  t.is(pagesOn({ hosted: false, accountOrigin: 'not a url' }), false)
  t.is(pagesOn({ hosted: false, accountOrigin: 42 }), false)
  t.is(pagesOn({ hosted: false }), false)
  t.is(pagesOn(), false)
  t.is(pagesCore({ hosted: false, accountOrigin: 'http://x.example' }), false)
})

test('a core node counts only when the bundle reaches the account origin', async (t) => {
  const { pagesOn, pagesCore, setCoreReach } = await load()
  t.teardown(() => setCoreReach(false))
  const core = { hosted: false, accountOrigin: 'https://varanda.example' }
  setCoreReach(false)
  t.is(pagesOn(core), false)
  t.is(pagesCore(core), false)
  setCoreReach('yes')
  t.is(pagesOn(core), false, 'only true turns it on')
  setCoreReach(true)
  t.is(pagesOn(core), true)
  t.is(pagesCore(core), true)
  t.is(pagesOn({ hosted: false, accountOrigin: 'http://varanda.example' }), false)
  t.is(pagesOn({ hosted: false, accountOrigin: '' }), false)
})
