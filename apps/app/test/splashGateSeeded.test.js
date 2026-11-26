'use strict'

const test = require('brittle')

const load = () => import('../src/splashGate.js')

// A seeded strip already has its layout, so seen state is not required.
// Ring colours may settle after the cover leaves, so profiles stay required.
test('splash gate: seeded settles a visible Momentos strip only as literal true', async (t) => {
  const { momentsSettled } = await load()
  const base = { phase: 'ready', stripVisible: true, seenLoaded: false, authors: [] }
  const answered = () => ({ avatar: null })
  for (const seeded of [true, false, undefined, 1, 'true']) {
    const literal = seeded === true
    t.is(momentsSettled({ ...base, seeded }), literal, 'empty rings, seen not loaded')
    t.is(momentsSettled({ ...base, seeded, seenLoaded: true }), true, 'seenLoaded still settles on its own')
    t.is(momentsSettled({ ...base, seeded, authors: ['a'] }), false, 'ring profiles are still required')
    t.is(momentsSettled({ ...base, seeded, authors: ['a'], profileOf: () => undefined }), false, 'an unanswered ring stays open')
    t.is(momentsSettled({ ...base, seeded, authors: ['a'], profileOf: () => ({ name: 'A', avatar: undefined }) }), false, 'avatar metadata is still required')
    t.is(momentsSettled({ ...base, seeded, authors: ['a', 'b'], profileOf: answered }), literal, 'answered rings settle only with literal seeded or seen')
    t.is(momentsSettled({ ...base, seeded, seenLoaded: true, authors: ['a'], profileOf: answered }), true, 'seenLoaded with answered rings')
    t.is(momentsSettled({ phase: 'idle', stripVisible: true, seenLoaded: false, authors: [], seeded }), false, 'seeded does not skip a phase that is not ready')
  }
  t.is(momentsSettled({ ...base, seeded: true, authors: undefined }), false, 'authors must be an array')
  t.is(momentsSettled({ ...base, seeded: true, authors: 'a' }), false, 'authors must be an array')
  t.is(momentsSettled({ ...base, seeded: true, authors: ['a'], profileOf: (key) => key === 'a' ? null : undefined }), true, 'null is a finished lookup')
})
