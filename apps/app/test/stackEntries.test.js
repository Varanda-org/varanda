'use strict'

// Rendered stack entries (src/stackEntries.js), a pure ES module; import()
// loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/stackEntries.js')

const a = { screen: 'membro', key: 'a' }
const b = { screen: 'conversa', key: 'b' }
const c = { screen: 'grupo', key: 'c' }

test('stackEntries lists the live stack with its indexes', async (t) => {
  const { stackEntries } = await load()
  t.alike(stackEntries([a, b], null), [{ entry: a, index: 0 }, { entry: b, index: 1 }])
  t.alike(stackEntries([], null), [])
  t.alike(stackEntries(null, null), [])
})

test('stackEntries keeps the departing screen at its old index in the same list', async (t) => {
  const { stackEntries } = await load()
  const before = stackEntries([a, b, c], null)
  const after = stackEntries([a, b], { entry: c, index: 2 })
  t.is(after.length, 3, 'one flat list, so React keeps the departing screen mounted')
  t.alike(after[2], before[2], 'same entry and index as before the pop')
  t.alike(after.slice(0, 2), before.slice(0, 2))
})

test('stackEntries drops a leaving entry a push already replaced', async (t) => {
  const { stackEntries } = await load()
  t.alike(stackEntries([a, b], { entry: c, index: 1 }), [{ entry: a, index: 0 }, { entry: b, index: 1 }])
  t.alike(stackEntries([a], { entry: null, index: 1 }), [{ entry: a, index: 0 }])
  t.alike(stackEntries([a], { entry: c, index: 'x' }), [{ entry: a, index: 0 }])
})

test('App.js renders the stack through one flat stackEntries list', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  t.ok(src.includes('stackEntries(stack, stackMotion.leaving).map('), 'live and leaving screens share one array')
  t.absent(src.includes('{stack.map(renderStackEntry)}'), 'no separate mapped array beside the leaving screen')
})
