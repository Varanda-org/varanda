// The acting identity store (src/actingAs.js): pure, no React.
'use strict'

const test = require('brittle')

const load = () => import('../src/actingAs.js')
const K = 'cd'.repeat(32)

test('starts as me and labels it Você', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  t.alike(a.get(), { kind: 'me' })
  t.is(a.isPage(), false)
  t.is(a.label(), 'Você')
})

test('asPage holds an immutable page identity and labels it by name', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  const next = a.asPage({ key: K, name: 'Padaria', username: 'padaria' })
  t.alike(next, { kind: 'page', key: K, name: 'Padaria', username: 'padaria' })
  t.is(a.get(), next)
  t.ok(Object.isFrozen(a.get()))
  t.is(a.isPage(), true)
  t.is(a.label(), 'Padaria')
})

test('a bad or closed key does not become the acting page and falls back to me', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  a.asPage({ key: K, name: 'Padaria', username: 'padaria' })
  for (const bad of [{ key: 'zz' }, { key: K.slice(2) }, { key: 5 }, {}, undefined, { key: K, closed: true }]) {
    a.asPage({ key: K, name: 'Padaria' })
    t.is(a.asPage(bad).kind, 'me', JSON.stringify(bad))
    t.is(a.isPage(), false)
  }
})

test('the label goes through displayText and never shows a raw key', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  a.asPage({ key: K, name: 'Pa‮ria', username: 'padaria' })
  t.is(a.label(), 'Pa�ria')
  a.asPage({ key: K, name: '', username: 'padaria' })
  t.is(a.label(), '@padaria')
  a.asPage({ key: K })
  t.is(a.label(), 'Página')
  t.absent(a.label().includes(K))
})

test('subscribers are told about a change, not about a repeat, and can unsubscribe', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  let n = 0
  const off = a.subscribe(() => { n++ })
  a.asPage({ key: K, name: 'A' })
  t.is(n, 1)
  a.asPage({ key: K, name: 'A' })
  t.is(n, 1, 'same identity')
  a.asPage({ key: K, name: 'B' })
  t.is(n, 2)
  a.me()
  t.is(n, 3)
  a.reset()
  t.is(n, 3, 'already me')
  off()
  a.asPage({ key: K })
  t.is(n, 3)
})

test('a throwing subscriber does not stop the others', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  let seen = 0
  a.subscribe(() => { throw new Error('x') })
  a.subscribe(() => { seen++ })
  a.asPage({ key: K })
  t.is(seen, 1)
  t.is(typeof a.subscribe(null), 'function')
})

test('set takes a page identity or falls back to me; reset clears', async (t) => {
  const { createActingAs } = await load()
  const a = createActingAs()
  a.set({ kind: 'page', key: K, name: 'P' })
  t.is(a.get().key, K)
  a.set({ kind: 'page', key: 'bad' })
  t.is(a.get().kind, 'me')
  a.set({ kind: 'page', key: K })
  a.reset()
  t.is(a.get().kind, 'me')
})

test('the module-level store is one shared instance', async (t) => {
  const m = await load()
  t.teardown(() => m.reset())
  let n = 0
  const off = m.subscribe(() => { n++ })
  m.asPage({ key: K, name: 'Loja' })
  t.is(m.get().name, 'Loja')
  t.is(m.isPage(), true)
  t.is(m.label(), 'Loja')
  t.is(n, 1)
  m.reset()
  t.is(m.isPage(), false)
  off()
})
