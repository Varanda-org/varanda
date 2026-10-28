'use strict'

// The side-inset helper (src/ui/sideInset.js), an ES module bundled by Metro;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')

const load = () => import('../src/ui/sideInset.js')

test('sideInset: what the centred column does not clear', async (t) => {
  const { sideInset } = await load()
  t.is(sideInset(0, 440, 640), 0)
  t.is(sideInset(59, 956, 640), 0)
  t.is(sideInset(47, 812, 640), 0)
  t.is(sideInset(59, 650, 640), 54)
  t.is(sideInset(16, 400, 640), 16)
  t.is(sideInset(0, 1280, 640), 0)
  t.is(sideInset(24, 640, 640), 24)
  t.is(sideInset(NaN, 400, 640), 0)
  t.is(sideInset(undefined, 400, 640), 0)
})
