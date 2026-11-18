'use strict'

// Preloaded (node -r) into a CLI child process by page-dm-cli tests: the
// Conversas engine gets short peek and close-drain limits. A page diary the
// test seeder never holds would otherwise keep every command waiting the
// full production peek deadline (20 s) before it exits.
const coreDm = require('@varanda/web-member/lib/core-dm')

const LIMITS = { peekDeadlineMs: 1000, closeDrainMs: 1000 }
const original = coreDm.createCoreDm

coreDm.createCoreDm = (options) => original({ ...options, limits: { ...LIMITS, ...(options && options.limits) } })
module.exports = { TEST_LIMITS: LIMITS }
