'use strict'

// The app bundles its own copy of the legal version (Metro cannot import
// @varanda/core); the account service checks acceptances against core's.
// They must never drift.

const test = require('brittle')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')

const load = () => import('../src/legal.js')

test('LEGAL_VERSION matches the core TERMS_VERSION', async (t) => {
  const { LEGAL_VERSION } = await load()
  t.ok(Number.isInteger(TERMS_VERSION))
  t.is(LEGAL_VERSION, TERMS_VERSION)
})
