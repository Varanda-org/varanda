'use strict'

// The blob URL LRU: eviction revokes, one shared load per key, and at most
// four loads at once.
const test = require('brittle')
const load = () => import('../src/media/cache.js')

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred () {
  const out = {}
  out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject })
  return out
}

test('retryDelay: 2 s, 5 s, 15 s for retryable failures, then stop', async (t) => {
  const { retryDelay, RETRY_DELAYS_MS } = await load()
  t.alike(Array.from(RETRY_DELAYS_MS), [2000, 5000, 15000])
  const notYet = Object.assign(new Error('indisponível'), { retryable: true })
  t.is(retryDelay(notYet, 0), 2000)
  t.is(retryDelay(notYet, 1), 5000)
  t.is(retryDelay(notYet, 2), 15000)
  t.is(retryDelay(notYet, 3), null, 'stops after three')
  t.is(retryDelay(notYet, -1), null)
  t.is(retryDelay(new Error('conteúdo não confere'), 0), null, 'mismatch never retried')
  t.is(retryDelay(null, 0), null)
})

test('mediaKey joins core, start, blocks and sha256', async (t) => {
  const { mediaKey } = await load()
  t.is(mediaKey({ core: 'a', start: 1, blocks: 2, sha256: 'b' }), 'a:1:2:b')
})

test('LRU eviction revokes the least recently used URL', async (t) => {
  const { createMediaCache } = await load()
  const revoked = []
  const cache = createMediaCache({ max: 2, revoke: (url) => revoked.push(url) })
  await cache.get('a', async () => 'blob:a')
  await cache.get('b', async () => 'blob:b')
  t.is(cache.peek('a'), 'blob:a', 'a becomes most recent')
  await cache.get('c', async () => 'blob:c')
  t.alike(revoked, ['blob:b'])
  t.is(cache.peek('b'), null)
  t.is(cache.size, 2)
  cache.clear()
  t.alike(revoked.sort(), ['blob:a', 'blob:b', 'blob:c'])
})

test('one shared in-flight load per key; failures are not cached', async (t) => {
  const { createMediaCache } = await load()
  const cache = createMediaCache({ revoke: () => {} })
  let calls = 0
  const d = deferred()
  const loader = () => { calls++; return d.promise }
  const p1 = cache.get('k', loader)
  const p2 = cache.get('k', loader)
  t.is(p1, p2)
  await tick()
  d.resolve('blob:k')
  t.is(await p1, 'blob:k')
  t.is(calls, 1)
  t.is(await cache.get('k', loader), 'blob:k')
  t.is(calls, 1, 'hit does not reload')

  let fails = 0
  await t.exception(() => cache.get('bad', async () => { fails++; throw new Error('x') }))
  t.is(await cache.get('bad', async () => { fails++; return 'blob:ok' }), 'blob:ok')
  t.is(fails, 2, 'retried after a failure')
})

test('at most four loads run at once', async (t) => {
  const { createMediaCache } = await load()
  const cache = createMediaCache({ revoke: () => {} })
  const gates = []
  let running = 0
  let peak = 0
  const loader = (i) => () => {
    running++
    peak = Math.max(peak, running)
    const g = deferred()
    gates[i] = g
    return g.promise.finally(() => { running-- })
  }
  const all = []
  for (let i = 0; i < 6; i++) all.push(cache.get('k' + i, loader(i)))
  await tick()
  t.is(running, 4)
  t.is(cache.active, 4)
  t.is(cache.waiting, 2)
  gates[0].resolve('blob:0')
  await tick()
  await tick()
  t.is(running, 4, 'the fifth started')
  t.ok(gates[4], 'fifth loader called')
  t.absent(gates[5], 'sixth still waiting')
  for (let i = 1; i < 5; i++) gates[i].resolve('blob:' + i)
  await tick()
  await tick()
  gates[5].resolve('blob:5')
  t.alike(await Promise.all(all), ['blob:0', 'blob:1', 'blob:2', 'blob:3', 'blob:4', 'blob:5'])
  t.is(peak, 4)
})

test('a transient load is stored once per key and evicted and revoked as usual', async (t) => {
  const { createMediaCache } = await load()
  const revoked = []
  const cache = createMediaCache({ max: 2, revoke: (u) => revoked.push(u) })
  let loads = 0
  const transient = (u) => () => { loads++; return Promise.resolve(u) }
  t.is(await cache.get('a', transient('blob:a')), 'blob:a')
  t.is(await cache.get('a', transient('blob:a2')), 'blob:a', 'same key, one entry')
  t.is(loads, 1)
  t.is(cache.size, 1)
  await cache.get('b', transient('blob:b'))
  await cache.get('c', transient('blob:c'))
  t.alike(revoked, ['blob:a'], 'oldest evicted and revoked')
  t.is(cache.peek('a'), null)
})
