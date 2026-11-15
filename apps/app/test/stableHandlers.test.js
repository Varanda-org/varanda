'use strict'

// Fixed-identity handlers for memoized screens (src/stableHandlers.js), a
// pure ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/stableHandlers.js')

test('a handler keeps its identity across updates and calls the latest implementation', async (t) => {
  const { createStableHandlers } = await load()
  const holder = createStableHandlers()
  const calls = []
  const first = holder.update({ onReply: (r) => { calls.push(['a', r]); return 'a' } })
  const second = holder.update({ onReply: (r) => { calls.push(['b', r]); return 'b' } })
  t.is(first.onReply, second.onReply, 'same function across renders')
  t.is(first.onReply('x'), 'b', 'an old reference reaches the newest implementation')
  t.alike(calls, [['b', 'x']], 'only the latest ran, with the arguments')
})

test('non-function values pass through unchanged', async (t) => {
  const { createStableHandlers } = await load()
  const holder = createStableHandlers()
  const obj = { a: 1 }
  const out = holder.update({ onX: undefined, onY: null, n: 3, obj })
  t.is(out.onX, undefined)
  t.is(out.onY, null)
  t.is(out.n, 3)
  t.is(out.obj, obj)
})

test('undefined to function and back changes identity', async (t) => {
  const { createStableHandlers } = await load()
  const holder = createStableHandlers()
  t.is(holder.update({ onAvisos: undefined }).onAvisos, undefined)
  const a = holder.update({ onAvisos: () => 1 }).onAvisos
  t.is(typeof a, 'function', 'appears as a function')
  t.is(holder.update({ onAvisos: () => 2 }).onAvisos, a, 'stays the same while present')
  t.is(holder.update({ onAvisos: undefined }).onAvisos, undefined, 'goes away')
  t.is(a(), undefined, 'a stale reference to a removed handler does nothing')
  const b = holder.update({ onAvisos: () => 3 }).onAvisos
  t.not(b, a, 'a new function once it comes back')
  t.is(b(), 3)
})

test('a handler missing from the map is dropped', async (t) => {
  const { createStableHandlers } = await load()
  const holder = createStableHandlers()
  const a = holder.update({ onX: () => 1 }).onX
  const out = holder.update({})
  t.absent('onX' in out)
  t.is(a(), undefined)
})

test('keyed sets keep one holder per key and sweep the unused ones', async (t) => {
  const { createStableHandlerSets } = await load()
  const sets = createStableHandlerSets()
  const a1 = sets.for('0:membro:k', { onTabChange: () => 'a1' }).onTabChange
  const b1 = sets.for('1:conversa:r', { onTabChange: () => 'b1' }).onTabChange
  t.not(a1, b1, 'separate keys, separate functions')
  sets.sweep()
  const a2 = sets.for('0:membro:k', { onTabChange: () => 'a2' }).onTabChange
  t.is(a2, a1, 'same key, same function')
  t.is(a1(), 'a2', 'calls the latest for that key')
  sets.sweep()
  t.is(sets.size(), 1, 'the key not used in the last round is gone')
  const b2 = sets.for('1:conversa:r', { onTabChange: () => 'b2' }).onTabChange
  t.not(b2, b1, 'a swept key starts fresh')
})
