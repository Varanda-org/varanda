'use strict'

const test = require('brittle')

const load = () => import('../src/autoSyncPolicy.js')

const ready = { wanted: true, phase: 'ready', online: true, active: null, starting: false, recovering: false, reconciling: false, backoffUntil: 0, awaitingRestartUntil: 0, now: 1000 }

test('wantsStart: the gate table', async (t) => {
  const { wantsStart } = await load()
  t.is(wantsStart(ready), true)
  t.is(wantsStart({ ...ready, online: undefined }), true)
  t.is(wantsStart({ ...ready, backoffUntil: undefined, awaitingRestartUntil: undefined }), true)
  t.is(wantsStart({ ...ready, wanted: false }), false)
  t.is(wantsStart({ ...ready, phase: 'booting' }), false)
  t.is(wantsStart({ ...ready, online: false }), false)
  t.is(wantsStart({ ...ready, active: { once: false } }), false)
  t.is(wantsStart({ ...ready, starting: true }), false)
  t.is(wantsStart({ ...ready, recovering: true }), false)
  t.is(wantsStart({ ...ready, reconciling: true }), false)
  t.is(wantsStart({ ...ready, backoffUntil: 1001 }), false)
  t.is(wantsStart({ ...ready, backoffUntil: 1000 }), true)
})

test('wantsStart: no start while awaiting the node restart', async (t) => {
  const { wantsStart } = await load()
  t.is(wantsStart({ ...ready, awaitingRestartUntil: 1500 }), false)
  t.is(wantsStart({ ...ready, awaitingRestartUntil: 1000 }), true)
  t.is(wantsStart({ ...ready, awaitingRestartUntil: 900 }), true)
})

test('afterPreempt: continuous runs wait for the node, once runs do not', async (t) => {
  const { afterPreempt, PREEMPT_GRACE_MS } = await load()
  t.alike(afterPreempt({ once: false, wanted: true, now: 5000 }), { awaitingRestartUntil: 5000 + PREEMPT_GRACE_MS })
  t.is(afterPreempt({ once: false, wanted: false, now: 5000 }), null)
  t.is(afterPreempt({ once: true, wanted: true, now: 5000 }), null)
})

test('graceExpired: reconcile once the grace passes with no run', async (t) => {
  const { graceExpired } = await load()
  t.is(graceExpired({ awaitingRestartUntil: 0, active: null, now: 9000 }), false)
  t.is(graceExpired({ awaitingRestartUntil: 5000, active: null, now: 4999 }), false)
  t.is(graceExpired({ awaitingRestartUntil: 5000, active: null, now: 5000 }), true)
  t.is(graceExpired({ awaitingRestartUntil: 5000, active: { once: false }, now: 9000 }), false)
})

test('nextBackoff: the ladder, its cap and its reset after a healthy run', async (t) => {
  const { nextBackoff } = await load()
  t.is(nextBackoff({ reason: 'preempted', startedAt: 0, stoppedAt: 1000, previousMs: 0 }), null)
  t.is(nextBackoff({ reason: 'stopped', startedAt: 0, stoppedAt: 1000, previousMs: 8000 }), 0)
  let ms = 0
  const ladder = []
  for (let i = 0; i < 8; i++) {
    ms = nextBackoff({ reason: 'error', startedAt: 0, stoppedAt: 1000, previousMs: ms })
    ladder.push(ms)
  }
  t.alike(ladder, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
  t.is(nextBackoff({ reason: 'error', startedAt: 0, stoppedAt: 1000, previousMs: 32000 }), 60000)
  t.is(nextBackoff({ reason: 'error', startedAt: 0, stoppedAt: 1000, previousMs: 60000 }), 60000)
  for (const reason of ['done', 'timeout', 'error']) {
    t.is(nextBackoff({ reason, startedAt: 0, stoppedAt: 60000, previousMs: 32000 }), 2000)
    t.is(nextBackoff({ reason, startedAt: 0, stoppedAt: 59999, previousMs: 0 }), 2000)
    t.is(nextBackoff({ reason, startedAt: 0, stoppedAt: 59999, previousMs: 2000 }), 4000)
  }
})

test('startFailure: the failure map', async (t) => {
  const { startFailure } = await load()
  t.is(startFailure({ code: 'USAGE', message: 'sincronização já em andamento' }), 'ignore')
  t.is(startFailure({ code: 'USAGE', message: 'outro erro' }), 'backoff')
  t.is(startFailure({ code: 'NOT_FOUND', message: 'sem identidade' }), 'give-up')
  t.is(startFailure({ code: 'TIMEOUT', uncertain: true }), 'reconcile')
  t.is(startFailure({ code: 'INTERNAL', message: 'x', uncertain: true }), 'reconcile')
  t.is(startFailure({ code: 'TIMEOUT', uncertain: false }), 'backoff')
  t.is(startFailure({ code: 'INTERNAL', message: 'x' }), 'backoff')
})
