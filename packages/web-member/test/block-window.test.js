'use strict'

const test = require('brittle')
const { pipeline } = require('../lib/block-window')

// A start() whose requests settle only when the test says so, recording how
// many are started and not yet consumed.
function controlled () {
  const pending = new Map() // seq -> { resolve, reject }
  const started = []
  let open = 0
  let maxOpen = 0
  return {
    started,
    pending,
    get maxOpen () { return maxOpen },
    consumed () { open-- },
    start (seq) {
      started.push(seq)
      open++
      maxOpen = Math.max(maxOpen, open)
      return new Promise((resolve, reject) => pending.set(seq, { resolve, reject }))
    }
  }
}

function tick () {
  return new Promise((resolve) => setImmediate(resolve))
}

test('results come back in seqs order whatever order they complete in', async (t) => {
  const c = controlled()
  const it = pipeline({ seqs: [9, 8, 7, 6, 5], inflight: 3, start: (seq) => c.start(seq) })
  const out = []
  const reader = (async () => {
    for await (const e of it) {
      c.consumed()
      out.push(e)
    }
  })()
  await tick()
  t.alike(c.started, [9, 8, 7], 'three started at once')
  c.pending.get(7).resolve('r7')
  c.pending.get(8).resolve('r8')
  await tick()
  t.alike(out, [], 'nothing yielded before the head arrives')
  c.pending.get(9).resolve('r9')
  await tick()
  t.alike(out.map((e) => e.seq), [9, 8, 7])
  c.pending.get(5).resolve('r5')
  c.pending.get(6).reject(new Error('boom'))
  await reader
  t.alike(out.map((e) => e.seq), [9, 8, 7, 6, 5])
  t.alike(out.map((e) => e.result), ['r9', 'r8', 'r7', undefined, 'r5'])
  t.is(out[3].error.message, 'boom', 'a rejection is captured as { error }')
  t.ok(c.maxOpen <= 3, 'never more than inflight started and not consumed')
  t.is(c.maxOpen, 3)
})

test('a start that throws synchronously is captured too', async (t) => {
  const it = pipeline({ seqs: [2, 1], inflight: 2, start: (seq) => { if (seq === 2) throw new Error('sync'); return seq } })
  const out = []
  for await (const e of it) out.push(e)
  t.is(out[0].error.message, 'sync')
  t.is(out[1].result, 1)
})

test('inflight 1 runs one request at a time', async (t) => {
  let open = 0
  let max = 0
  const it = pipeline({
    seqs: [5, 4, 3, 2],
    inflight: 1,
    start: async (seq) => {
      open++
      max = Math.max(max, open)
      await tick()
      return seq
    }
  })
  const seen = []
  for await (const e of it) {
    open--
    seen.push(e.result)
  }
  t.alike(seen, [5, 4, 3, 2])
  t.is(max, 1)
})

test('canStart false stops dispatch; it resumes on the next consumption once true again', async (t) => {
  const c = controlled()
  let allow = true
  const asked = []
  const it = pipeline({
    seqs: [6, 5, 4, 3],
    inflight: 3,
    canStart: () => { asked.push(c.started.length); return allow },
    start: (seq) => c.start(seq)
  })
  const first = it.next()
  await tick()
  t.alike(c.started, [6, 5, 4])
  allow = false
  c.pending.get(6).resolve(6)
  t.is((await first).value.seq, 6)
  const second = it.next()
  await tick()
  t.alike(c.started, [6, 5, 4], 'nothing started while canStart is false')
  c.pending.get(5).resolve(5)
  t.is((await second).value.seq, 5)
  allow = true
  const third = it.next()
  await tick()
  t.alike(c.started, [6, 5, 4, 3], 'dispatch resumed on the next consumption')
  c.pending.get(4).resolve(4)
  c.pending.get(3).resolve(3)
  t.is((await third).value.seq, 4)
  t.is((await it.next()).value.seq, 3)
  t.is((await it.next()).done, true)
  t.ok(asked.length >= 4, 'canStart asked before every start')
})

test('canStart false with nothing in flight ends the iteration', async (t) => {
  let started = 0
  const it = pipeline({ seqs: [3, 2, 1], inflight: 3, canStart: () => false, start: () => { started++ } })
  const out = []
  for await (const e of it) out.push(e)
  t.alike(out, [])
  t.is(started, 0)
})

test('the consumer can change what start sees before the next seq goes out', async (t) => {
  const skip = new Set()
  const started = []
  const it = pipeline({
    seqs: [4, 3, 2, 1],
    inflight: 1,
    start: (seq) => { started.push(seq); return skip.has(seq) ? 'skipped' : seq }
  })
  const results = []
  for await (const e of it) {
    results.push(e.result)
    if (e.seq === 4) skip.add(3)
  }
  t.alike(started, [4, 3, 2, 1])
  t.alike(results, [4, 'skipped', 2, 1], 'seq 3 was started after seq 4 was consumed')
})

test('stop() starts nothing more and leaves no unhandled rejection', async (t) => {
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  t.teardown(() => process.off('unhandledRejection', onUnhandled))
  const c = controlled()
  const it = pipeline({ seqs: [9, 8, 7, 6, 5], inflight: 3, start: (seq) => c.start(seq) })
  setImmediate(() => c.pending.get(9).resolve(9))
  // eslint-disable-next-line no-unreachable-loop
  for await (const e of it) {
    t.is(e.seq, 9)
    break
  }
  // The break called return(), which stops the window.
  const before = c.started.length
  t.is(before, 3)
  c.pending.get(8).reject(new Error('abandoned'))
  c.pending.get(7).reject(new Error('abandoned'))
  await tick()
  await tick()
  t.is((await it.next()).done, true, 'a stopped window yields nothing more')
  t.is(c.started.length, before, 'nothing started after stop')
  t.alike(unhandled, [], 'no unhandled rejection')

  // An explicit stop() with entries in flight.
  const d = controlled()
  const w = pipeline({ seqs: [3, 2, 1], inflight: 3, start: (seq) => d.start(seq) })
  const head = w.next()
  await tick()
  d.pending.get(3).resolve(3)
  await head
  w.stop()
  d.pending.get(2).reject(new Error('abandoned'))
  d.pending.get(1).reject(new Error('abandoned'))
  await tick()
  await tick()
  t.is((await w.next()).done, true)
  t.alike(unhandled, [])
})

test('skip: an entry the consumer no longer wants is yielded at once, unawaited', async (t) => {
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  t.teardown(() => process.off('unhandledRejection', onUnhandled))
  const c = controlled()
  const gone = new Set()
  const it = pipeline({ seqs: [5, 4, 3, 2], inflight: 3, start: (seq) => c.start(seq), skip: (seq) => gone.has(seq) })
  const first = it.next()
  await tick()
  t.alike(c.started, [5, 4, 3])
  c.pending.get(5).resolve(5)
  t.is((await first).value.seq, 5)
  const second = it.next()
  await tick()
  t.alike(c.started, [5, 4, 3, 2], 'the slot of 5 went to 2')
  c.pending.get(4).resolve(4)
  t.is((await second).value.seq, 4)
  gone.add(3)
  // 3 never settles: without skip this would hang.
  t.alike((await it.next()).value, { seq: 3, skipped: true }, 'skipped without waiting for its request')
  c.pending.get(2).resolve(2)
  t.alike((await it.next()).value, { seq: 2, result: 2 })
  t.is((await it.next()).done, true)
  c.pending.get(3).reject(new Error('abandoned'))
  await tick()
  await tick()
  t.alike(unhandled, [], 'the abandoned request leaves no unhandled rejection')
})

test('skip: a skipped request holds its slot until it settles; next() waits for it instead of ending', async (t) => {
  const c = controlled()
  const gone = new Set()
  const cancelled = []
  const it = pipeline({
    seqs: [6, 5, 4, 3],
    inflight: 2,
    start: (seq) => c.start(seq),
    skip: (seq) => gone.has(seq),
    cancel: (seq) => cancelled.push(seq)
  })
  const first = it.next()
  await tick()
  t.alike(c.started, [6, 5])
  c.pending.get(6).resolve(6)
  t.is((await first).value.seq, 6)
  gone.add(5)
  // Starts 4 (5 still counts), then 5 reaches the head and is skipped.
  t.alike((await it.next()).value, { seq: 5, skipped: true })
  t.alike(cancelled, [5], 'cancel called for the skipped request')
  t.alike(c.started, [6, 5, 4])
  const third = it.next()
  await tick()
  t.alike(c.started, [6, 5, 4], 'no start while the skipped request still holds its slot')
  c.pending.get(5).reject(new Error('cancelled'))
  c.pending.get(4).resolve(4)
  t.is((await third).value.seq, 4)
  const fourth = it.next()
  await tick()
  t.alike(c.started, [6, 5, 4, 3], 'its slot freed once it settled, refilled on the next consumption')
  c.pending.get(3).resolve(3)
  t.is((await fourth).value.seq, 3)

  // Every slot held by a skipped request: next() waits, it does not end.
  const d = controlled()
  const w = pipeline({ seqs: [2, 1], inflight: 1, start: (seq) => d.start(seq), skip: (seq) => seq === 2 })
  t.alike((await w.next()).value, { seq: 2, skipped: true })
  let settled = false
  const after = w.next().then((r) => { settled = true; return r })
  await tick()
  t.is(settled, false, 'waiting for the skipped request')
  t.alike(d.started, [2])
  d.pending.get(2).reject(new Error('cancelled'))
  await tick()
  t.alike(d.started, [2, 1])
  d.pending.get(1).resolve(1)
  t.alike((await after).value, { seq: 1, result: 1 })
  t.is((await w.next()).done, true)
})
