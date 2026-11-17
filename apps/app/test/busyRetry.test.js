// The retry of a read the node answers with 'ocupado' (src/busyRetry.js).
'use strict'

const test = require('brittle')

const load = () => import('../src/busyRetry.js')
const busy = () => Object.assign(new Error('ocupado'), { code: 'USAGE' })
const noWait = async () => {}

test('readRetryingBusy: a busy read is asked again with growing waits and is no failure when still busy', async (t) => {
  const { readRetryingBusy } = await load()
  let calls = 0
  const waits = []
  const sleep = async (ms) => { waits.push(ms) }
  const ok = await readRetryingBusy(async () => (++calls < 3 ? Promise.reject(busy()) : { roster: 1 }), { sleep, ms: 10 })
  t.alike(ok, { busy: false, value: { roster: 1 } }, 'answers after two busy replies')
  t.alike(waits, [10, 20])

  calls = 0
  const still = await readRetryingBusy(async () => { calls++; throw busy() }, { sleep: noWait, tries: 3 })
  t.alike(still, { busy: true }, 'still busy: quiet, not thrown')
  t.is(calls, 4, 'one ask and three retries')

  await t.exception(readRetryingBusy(async () => { throw Object.assign(new Error('erro interno'), { code: 'INTERNAL' }) }, { sleep: noWait }), /erro interno/, 'any other error is thrown')
  t.alike(await readRetryingBusy(async () => 1, { alive: () => false }), { busy: true }, 'a read for a screen gone is not made')
})

test('readRetryingBusy: goes through the shared slots, ahead of the background reads', async (t) => {
  const { readRetryingBusy } = await load()
  const seen = []
  const slots = { run: (fn, opts) => { seen.push(opts); return fn() } }
  const out = await readRetryingBusy(async () => 7, { slots })
  t.alike(out, { busy: false, value: 7 })
  t.alike(seen, [{ front: true }])
})

test('readRetryingBusy: a screen gone while the read waited for a slot is skipped, not answered with null', async (t) => {
  const { readRetryingBusy } = await load()
  let live = true
  let asked = 0
  const slots = { run: async (fn) => { live = false; return fn() } }
  const out = await readRetryingBusy(async () => { asked++; return { roster: 1 } }, { slots, alive: () => live })
  t.alike(out, { busy: true })
  t.is(asked, 0, 'the read was never made')
})
