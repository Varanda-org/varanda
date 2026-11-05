'use strict'

const test = require('brittle')

test('pageReach: native reaches another origin, the web bundle does not', async (t) => {
  t.is((await import('../src/pageReach.native.js')).CROSS_ORIGIN_PAGES, true)
  t.is((await import('../src/pageReach.web.js')).CROSS_ORIGIN_PAGES, false)
})
