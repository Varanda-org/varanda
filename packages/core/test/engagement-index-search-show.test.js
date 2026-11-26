'use strict'

const test = require('brittle')
const { createEngagementIndex } = require('../lib/engagement-index')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const searchShow = (on) => ({ type: 'search-show', on, at: AT })

test('accounts are searchable by default for known and unknown authors', (t) => {
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 1, { type: 'profile', name: 'Ana', bio: '', at: AT }))
  t.is(ix.searchShown(A), true)
  t.is(ix.searchShown(B), true)
})

test('search-show uses the highest live seq regardless of arrival order', (t) => {
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 2, searchShow(false)))
  t.is(ix.searchShown(A), false)
  t.is(ix.searchShown(B), true)
  t.ok(ix.add(A, 1, searchShow(true)))
  t.is(ix.searchShown(A), false)
  t.ok(ix.add(A, 3, searchShow(true)))
  t.is(ix.searchShown(A), true)
  t.ok(ix.removeRecord(A, 3))
  t.is(ix.searchShown(A), false)
  t.ok(ix.removeRecord(A, 2))
  t.is(ix.searchShown(A), true)
})

test('deleting the only search-show record restores the default', (t) => {
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 1, searchShow(false)))
  t.is(ix.searchShown(A), false)
  t.ok(ix.removeRecord(A, 1))
  t.is(ix.searchShown(A), true)
})

test('search-show rejects non-boolean values', (t) => {
  const ix = createEngagementIndex()
  for (const on of [undefined, null, 0, 'false']) {
    t.is(ix.add(A, 1, searchShow(on)), false)
  }
  t.is(ix.stats().records, 0)
  t.is(ix.searchShown(A), true)
})
