'use strict'

const test = require('brittle')
const { createEngagementIndex } = require('../lib/engagement-index')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const groupsShow = (on) => ({ type: 'groups-show', on, at: AT })

test('groups are shown by default for known and unknown authors', (t) => {
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 1, { type: 'profile', name: 'Ana', bio: '', at: AT }))
  t.is(ix.groupsShown(A), true)
  t.is(ix.groupsShown(B), true)
})

test('groups-show uses the highest live seq regardless of arrival order', (t) => {
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 2, groupsShow(false)))
  t.is(ix.groupsShown(A), false)
  t.is(ix.groupsShown(B), true)
  t.ok(ix.add(A, 1, groupsShow(true)))
  t.is(ix.groupsShown(A), false)
  t.ok(ix.add(A, 3, groupsShow(true)))
  t.is(ix.groupsShown(A), true)
  t.ok(ix.removeRecord(A, 3))
  t.is(ix.groupsShown(A), false)
  t.ok(ix.removeRecord(A, 2))
  t.is(ix.groupsShown(A), true)
})

test('deleting the only groups-show record restores the default', (t) => {
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 1, groupsShow(false)))
  t.is(ix.groupsShown(A), false)
  t.ok(ix.removeRecord(A, 1))
  t.is(ix.groupsShown(A), true)
})

test('groups-show rejects non-boolean values', (t) => {
  const ix = createEngagementIndex()
  for (const on of [undefined, null, 0, 'false']) {
    t.is(ix.add(A, 1, groupsShow(on)), false)
  }
  t.is(ix.stats().records, 0)
  t.is(ix.groupsShown(A), true)
})
