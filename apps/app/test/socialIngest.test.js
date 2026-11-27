'use strict'

const test = require('brittle')
const load = () => import('../src/socialIngest.js')

function deferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

const turn = () => new Promise((resolve) => setImmediate(resolve))

test('together starts both reads and waits for both in either completion order', async (t) => {
  const { firstReads } = await load()
  for (const first of [0, 1]) {
    const reads = [deferred(), deferred()]
    const started = []
    let settled = false
    const run = firstReads({
      together: true,
      engagement: () => { started.push('engagement'); return reads[0].promise },
      resolve: () => { started.push('resolve'); return reads[1].promise }
    }).then((value) => { settled = true; return value })
    await turn()
    t.alike(started, ['engagement', 'resolve'], 'both start before either settles')
    reads[first].resolve('first')
    await turn()
    t.is(settled, false, 'one completed read does not finish the join')
    reads[1 - first].resolve('last')
    t.is(await run, undefined)
  }
})

test('without together resolve waits for engagement', async (t) => {
  const { firstReads } = await load()
  const engagement = deferred()
  const original = deferred()
  const started = []
  let settled = false
  const run = firstReads({
    engagement: () => { started.push('engagement'); return engagement.promise },
    resolve: () => { started.push('resolve'); return original.promise }
  }).then((value) => { settled = true; return value })
  await turn()
  t.alike(started, ['engagement'])
  engagement.resolve()
  await turn()
  t.alike(started, ['engagement', 'resolve'])
  t.is(settled, false)
  original.resolve('original')
  t.is(await run, undefined)
})

test('together waits after rejection and keeps the first error by time', async (t) => {
  const { firstReads } = await load()
  for (const first of [0, 1]) {
    for (const bothReject of [false, true]) {
      const reads = [deferred(), deferred()]
      const firstError = new Error('first failure')
      let settled = false
      const run = firstReads({
        together: true,
        engagement: () => reads[0].promise,
        resolve: () => reads[1].promise
      }).then(
        () => { settled = true; return null },
        (err) => { settled = true; return err }
      )
      reads[first].reject(firstError)
      await turn()
      t.is(settled, false, 'a rejection still waits for the other read')
      if (bothReject) reads[1 - first].reject(new Error('later failure'))
      else reads[1 - first].resolve()
      t.is(await run, firstError, 'the earliest rejection wins regardless of branch order')
    }
  }
})

test('without together an engagement rejection never starts resolve', async (t) => {
  const { firstReads } = await load()
  const engagement = deferred()
  const error = new Error('engagement failed')
  let resolved = false
  const run = firstReads({
    together: false,
    engagement: () => engagement.promise,
    resolve: () => { resolved = true }
  }).then(() => null, (err) => err)
  engagement.reject(error)
  t.is(await run, error)
  t.is(resolved, false)
})

test('reads may return undefined and only true enables together', async (t) => {
  const { firstReads } = await load()
  t.is(await firstReads({ together: true, engagement: () => {}, resolve: () => {} }), undefined)
  for (const together of [false, undefined, 1]) {
    const engagement = deferred()
    let resolved = false
    const run = firstReads({
      together,
      engagement: () => engagement.promise,
      resolve: () => { resolved = true }
    })
    await turn()
    t.is(resolved, false)
    engagement.resolve()
    t.is(await run, undefined)
    t.is(resolved, true)
  }
})
