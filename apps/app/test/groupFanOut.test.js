'use strict'

const test = require('brittle')

const load = () => import('../src/groupFanOut.js')
const row = (group) => ({ group })
const page = (groups, fields = {}) => ({
  ok: true,
  value: { groups, next: null, hidden: false, complete: true, indexing: false, ...fields }
})
const refusal = (reason) => ({ ok: false, reason })

function fakeIndex (responses, durations = []) {
  let time = 0
  let active = 0
  let peak = 0
  const calls = []
  return {
    calls,
    peak: () => peak,
    deps: {
      now: () => time,
      sleep: async (ms) => { time += ms },
      fetchPage: async (diary, after) => {
        const i = calls.length
        calls.push({ diary, after, start: time })
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        time += durations[i] ?? 0
        active--
        return responses[i]
      }
    }
  }
}

test('fan-out reads one page at a time and spaces request starts', async (t) => {
  const { fanOut, DIARY_PAGES, FANOUT_GAP_MS } = await load()
  const a = row('a1')
  const b = row('a2')
  const c = row('b1')
  const index = fakeIndex([page([a], { next: a.group }), page([b], { next: b.group }), page([c])], [100, 900])
  const out = await fanOut(['a', 'b'], () => true, index.deps)
  t.is(DIARY_PAGES, 2)
  t.is(FANOUT_GAP_MS, 750)
  t.is(index.peak(), 1)
  t.alike(index.calls, [
    { diary: 'a', after: null, start: 0 },
    { diary: 'a', after: a.group, start: FANOUT_GAP_MS },
    { diary: 'b', after: null, start: FANOUT_GAP_MS + 900 }
  ])
  t.alike(out, { perDiary: [{ diary: 'a', groups: [a, b] }, { diary: 'b', groups: [c] }], answeredAll: true })
})

test('a hidden second page discards the diary and keeps other diaries', async (t) => {
  const { fanOut } = await load()
  const a = row('a1')
  const b = row('b1')
  const c = row('c1')
  const { deps, calls } = fakeIndex([
    page([a]), page([b], { next: b.group }), page([], { hidden: true }), page([c])
  ])
  const out = await fanOut(['a', 'b', 'c'], () => true, deps)
  t.alike(calls.map(({ diary, after }) => [diary, after]), [['a', null], ['b', null], ['b', b.group], ['c', null]])
  t.alike(out, { perDiary: [{ diary: 'a', groups: [a] }, { diary: 'c', groups: [c] }], answeredAll: true })
})

test('not-found skips the diary without marking the fan-out incomplete', async (t) => {
  const { fanOut } = await load()
  const a = row('a1')
  const b = row('b1')
  const { deps, calls } = fakeIndex([page([a], { next: a.group }), refusal('not-found'), page([b])])
  const out = await fanOut(['a', 'b'], () => true, deps)
  t.alike(calls.map(({ diary }) => diary), ['a', 'a', 'b'])
  t.alike(out, { perDiary: [{ diary: 'b', groups: [b] }], answeredAll: true })
})

test('rate-limited stops the fan-out and keeps gathered rows', async (t) => {
  const { fanOut } = await load()
  const a = row('a1')
  const { deps, calls } = fakeIndex([page([a], { next: a.group }), refusal('rate-limited')])
  const out = await fanOut(['a', 'b'], () => true, deps)
  t.alike(calls.map(({ diary }) => diary), ['a', 'a'])
  t.alike(out, { perDiary: [{ diary: 'a', groups: [a] }], answeredAll: false })
})

test('only consecutive failures count toward the fan-out stop', async (t) => {
  const { fanOut, FANOUT_MAX_FAILURES } = await load()
  const kept = row('kept')
  const failures = Array.from({ length: FANOUT_MAX_FAILURES }, () => refusal('timeout'))
  const short = failures.slice(1)
  const responses = [...short, refusal('not-found'), ...short, page([kept]), ...failures]
  const { deps, calls } = fakeIndex(responses)
  const sample = Array.from({ length: responses.length + 1 }, (_, i) => String(i))
  const out = await fanOut(sample, () => true, deps)
  t.is(FANOUT_MAX_FAILURES, 3)
  t.alike(calls.map(({ diary }) => diary), sample.slice(0, -1))
  t.alike(out, { perDiary: [{ diary: sample[short.length * 2 + 1], groups: [kept] }], answeredAll: false })
})

test('a superseded fan-out returns null even on its last page', async (t) => {
  const { fanOut } = await load()
  const { deps, calls } = fakeIndex([page([row('a1')])])
  let alive = true
  const fetchPage = async (...args) => {
    const result = await deps.fetchPage(...args)
    alive = false
    return result
  }
  t.is(await fanOut(['a'], () => alive, { ...deps, fetchPage }), null)
  t.is(calls.length, 1)
})

test('an incomplete answer contributes its rows without a retry', async (t) => {
  const { fanOut } = await load()
  const a = row('a1')
  const b = row('b1')
  const { deps, calls } = fakeIndex([page([a], { complete: false }), page([b])])
  const out = await fanOut(['a', 'b'], () => true, deps)
  t.alike(calls.map(({ diary, after }) => [diary, after]), [['a', null], ['b', null]])
  t.alike(out, { perDiary: [{ diary: 'a', groups: [a] }, { diary: 'b', groups: [b] }], answeredAll: true })
})

test('by default the fan-out reads /index/discover/of, never the legacy public groups', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const { transformSync } = require('@babel/core')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'groupFanOut.js'), 'utf8')
  const { code } = transformSync(src, { babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] })
  const calls = []
  const index = {
    fetchStandaloneGroupsOf: async (diary, after) => {
      calls.push([diary, after])
      return page([row('g1')])
    }
  }
  const deps = {
    './groupShelves.js': await import('../src/groupShelves.js'),
    './indexClient.js': new Proxy(index, {
      get: (target, name) => {
        if (name in target || typeof name !== 'string' || name === '__esModule') return target[name]
        throw new Error('unexpected index call: ' + name)
      }
    })
  }
  const exports = {}
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', code)((name) => deps[name], exports)
  const out = await exports.fanOut(['d1'], () => true, { sleep: async () => {}, now: () => 0 })
  t.alike(calls, [['d1', null]])
  t.alike(out.perDiary, [{ diary: 'd1', groups: [row('g1')] }])
})
