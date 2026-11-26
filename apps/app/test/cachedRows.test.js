'use strict'

const test = require('brittle')
const load = () => import('../src/cachedRows.js')
const row = (...authors) => Object.freeze({ authors: Object.freeze(authors) })
const authorsOf = (row) => row.authors

test('cachedRowsShown fails closed until blocks load, except for entirely own content', async (t) => {
  const { cachedRowsShown } = await load()
  const own = row('AA', 'aa')
  const rows = Object.freeze([own, row('bb'), row('aa', 'bb'), row()])
  const options = Object.freeze({ blocked: null, owner: 'Aa', authorsOf })
  for (const loadState of ['pending', 'failed', undefined]) {
    t.alike(cachedRowsShown(rows, { ...options, loadState }), [own])
  }
  t.is(cachedRowsShown(rows, { ...options, loadState: 'ok' }), rows)
  t.alike(cachedRowsShown(rows, { ...options, loadState: 'pending', owner: null }), [])
  t.is(cachedRowsShown(rows, { ...options, loadState: 'ok', owner: 1 }), rows)
})

test('cachedRowsShown rechecks every visible author when a block or mute arrives', async (t) => {
  const { cachedRowsShown } = await load()
  const own = row('aa')
  const other = row('bb')
  const rows = Object.freeze([own, row('cc'), other, row('aa', 'cc'), row('aa', 'bb')])
  const options = { loadState: 'ok', blocked: new Set(), owner: 'aa', authorsOf }
  t.is(cachedRowsShown(rows, options), rows)
  options.blocked.add('cc')
  t.alike(cachedRowsShown(rows, options), [own, other, rows[4]])
  const muted = { keys: ['aa', 'bb'], has (key) { return this.keys.includes(key) } }
  t.alike(cachedRowsShown(rows, { ...options, muted }), [own])
  t.alike(cachedRowsShown(rows, { ...options, owner: null, muted }), [])
  t.alike(cachedRowsShown(rows, { ...options, blocked: new Set(['aa']), muted: null }), [own, rows[1], other])
})

test('withoutBlockedRows excludes any blocked author when building a snapshot', async (t) => {
  const { withoutBlockedRows } = await load()
  const own = row('aa')
  const neutral = row()
  const rows = Object.freeze([own, row('bb'), row('aa', 'bb'), neutral])
  t.alike(withoutBlockedRows(rows, new Set(['bb']), authorsOf), [own, neutral])
  t.alike(withoutBlockedRows(rows, new Set(['aa']), authorsOf), [rows[1], neutral])
  t.is(withoutBlockedRows(rows, { has: () => false }, authorsOf), rows)
  t.is(withoutBlockedRows(rows, null, authorsOf), rows)
})

test('cached row filters handle malformed inputs without showing unknown authors', async (t) => {
  const { cachedRowsShown, withoutBlockedRows } = await load()
  const options = { loadState: 'ok', blocked: null, owner: 'aa', authorsOf }
  for (const input of [null, undefined, {}, 'rows']) {
    t.alike(cachedRowsShown(input, options), [])
    t.alike(withoutBlockedRows(input, null, authorsOf), [])
  }
  const empty = Object.freeze([])
  t.is(cachedRowsShown(empty, options), empty)
  t.is(withoutBlockedRows(empty, new Set(), authorsOf), empty)
  const rows = Object.freeze([row('aa'), { authors: null }, row(undefined), row('bb'), { authors: Array(1) }])
  t.alike(cachedRowsShown(rows, null), [])
  t.alike(cachedRowsShown(rows, options), [rows[0], rows[3]])
  t.alike(cachedRowsShown(rows, { ...options, blocked: {} }), [rows[0]])
  t.alike(withoutBlockedRows(rows, new Set(['bb']), authorsOf), [rows[0]])
  t.alike(withoutBlockedRows(rows, new Set(), null), [])
})
