'use strict'

// src/sentinel/bench.js: the dev-only Sentinela benchmark helpers. ES module
// loaded through import(); it imports nothing, so no stub is needed.
const test = require('brittle')

const load = () => import('../src/sentinel/bench.js')

test('sentinelBenchEnabled: dev must be exactly true and the env flag exactly "1"', async (t) => {
  const { sentinelBenchEnabled } = await load()
  t.is(sentinelBenchEnabled({ EXPO_PUBLIC_VARANDA_SENTINEL_BENCH: '1' }, false), false)
  t.is(sentinelBenchEnabled({ EXPO_PUBLIC_VARANDA_SENTINEL_BENCH: '0' }, true), false)
  t.is(sentinelBenchEnabled({}, true), false)
  t.is(sentinelBenchEnabled(null, true), false)
  t.is(sentinelBenchEnabled({ EXPO_PUBLIC_VARANDA_SENTINEL_BENCH: '1' }, true), true)
  // Truthy is not enough: only the boolean true and the string '1' count.
  for (const dev of ['true', 1, undefined, {}]) {
    t.is(sentinelBenchEnabled({ EXPO_PUBLIC_VARANDA_SENTINEL_BENCH: '1' }, dev), false, 'dev ' + String(dev))
  }
  for (const flag of [1, 'true', true, ' 1']) {
    t.is(sentinelBenchEnabled({ EXPO_PUBLIC_VARANDA_SENTINEL_BENCH: flag }, true), false, 'flag ' + String(flag))
  }
})

// The real gate lives inline in index.js so Metro can fold __DEV__ and the
// EXPO_PUBLIC_ value and drop the require from a release bundle.
test('index.js starts the bench only behind the inline dev gate', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const gate = "if (__DEV__ && process.env.EXPO_PUBLIC_VARANDA_SENTINEL_BENCH === '1') {\n  setTimeout(() => require('./src/sentinel/runBench').runSentinelBench(), 6000)\n}"
  t.ok(src.includes(gate))
  t.is(src.split('src/sentinel/runBench').length, 2, 'one call site only')
})

test('summary: nearest-rank percentiles on 1..100', async (t) => {
  const { summary } = await load()
  const xs = Array.from({ length: 100 }, (_, i) => i + 1)
  t.alike(summary(xs), { n: 100, p50: 50, p95: 95, min: 1, max: 100 })
})

test('summary: sorts a copy and leaves the input alone', async (t) => {
  const { summary } = await load()
  const xs = [5, 1, 3]
  t.alike(summary(xs), { n: 3, p50: 3, p95: 5, min: 1, max: 5 })
  t.alike(xs, [5, 1, 3])
})

test('summary: empty input gives nulls', async (t) => {
  const { summary } = await load()
  t.alike(summary([]), { n: 0, p50: null, p95: null, min: null, max: null })
})

test('summary: rejects non-numeric samples', async (t) => {
  const { summary } = await load()
  t.exception(() => summary([1, 'x']))
  t.exception(() => summary([1, NaN]))
})

test('cosine: identical vectors are 1, orthogonal are 0', async (t) => {
  const { cosine } = await load()
  t.is(cosine([1, 0, 0], [1, 0, 0]), 1)
  t.is(cosine([1, 0], [0, 1]), 0)
  t.is(cosine([0.6, 0.8], [0.6, 0.8]), 1)
})

test('cosine: throws on length mismatch, empty, non-finite, zero norm', async (t) => {
  const { cosine } = await load()
  t.exception(() => cosine([1, 2], [1, 2, 3]))
  t.exception(() => cosine([], []))
  t.exception(() => cosine([1, Infinity], [1, 1]))
  t.exception(() => cosine([0, 0], [1, 1]))
  t.exception(() => cosine('ab', 'ab'))
})

test('formatLine: exact output, rounded to 2 decimals, null as dash', async (t) => {
  const { formatLine } = await load()
  t.is(
    formatLine('embed-cpu', { n: 100, p50: 12.345, p95: 20, min: null, max: 21.999 }),
    'sentinel-bench embed-cpu n=100 p50=12.35 p95=20 min=- max=22'
  )
})

test('formatLine: rejects bad names', async (t) => {
  const { formatLine } = await load()
  t.exception(() => formatLine('Bad Name', { n: 1 }))
  t.exception(() => formatLine('', { n: 1 }))
  t.exception(() => formatLine(42, { n: 1 }))
})

test('formatLine: rejects arrays, strings and non-finite values in stats', async (t) => {
  const { formatLine } = await load()
  t.exception(() => formatLine('ok', [1, 2]))
  t.exception(() => formatLine('ok', { samples: [1, 2] }))
  t.exception(() => formatLine('ok', { label: 'texto' }))
  t.exception(() => formatLine('ok', { n: Infinity }))
  t.exception(() => formatLine('ok', null))
})

test('maxAbsDiff: largest elementwise gap, validates its input', async (t) => {
  const { maxAbsDiff } = await load()
  t.is(maxAbsDiff([1, 2, 3], [1, 2, 3]), 0)
  t.is(maxAbsDiff([1, -2, 3], [1.5, -2.25, 2]), 1)
  t.exception(() => maxAbsDiff([1, 2], [1]))
  t.exception(() => maxAbsDiff([], []))
  t.exception(() => maxAbsDiff([1, NaN], [1, 2]))
})

test('argmax: index of the largest element, first on a tie', async (t) => {
  const { argmax } = await load()
  t.is(argmax([0.1, 0.9, -1]), 1)
  t.is(argmax([-3, -2, -1]), 2)
  t.is(argmax([2, 2, 1]), 0)
  t.exception(() => argmax([]))
  t.exception(() => argmax([1, 'x']))
})
