'use strict'

const test = require('brittle')
const load = () => import('../src/photoUndo.js')
const p = (id) => ({ id })

test('removeById takes the photo out and remembers where it was', async (t) => {
  const { removeById } = await load()
  const list = [p(1), p(2), p(3)]
  const r = removeById(list, 2)
  t.alike(r.list.map((x) => x.id), [1, 3])
  t.is(r.removed.item, list[1])
  t.is(r.removed.index, 1)
  t.alike(list.map((x) => x.id), [1, 2, 3], 'the input list is untouched')
  const none = removeById(list, 9)
  t.is(none.list, list)
  t.is(none.removed, null)
  t.is(removeById(null, 1).removed, null)
})

test('restoreRemoved puts the photo back at its index', async (t) => {
  const { removeById, restoreRemoved } = await load()
  for (const id of [1, 2, 3]) {
    const r = removeById([p(1), p(2), p(3)], id)
    t.alike(restoreRemoved(r.list, r.removed).map((x) => x.id), [1, 2, 3], 'photo ' + id)
  }
})

test('restoreRemoved clamps the index when the list shrank and keeps later photos in place', async (t) => {
  const { removeById, restoreRemoved } = await load()
  const r = removeById([p(1), p(2), p(3)], 3)
  t.alike(restoreRemoved([p(1)], r.removed).map((x) => x.id), [1, 3], 'shrunk list: at the end')
  const mid = removeById([p(1), p(2), p(3)], 2)
  t.alike(restoreRemoved([p(1), p(3), p(4)], mid.removed).map((x) => x.id), [1, 2, 3, 4], 'a photo added meanwhile stays')
  t.alike(restoreRemoved([p(1), p(2)], { item: p(9), index: -1 }).map((x) => x.id), [9, 1, 2], 'a negative index lands first')
})

test('restoreRemoved never duplicates a photo or passes the cap', async (t) => {
  const { removeById, restoreRemoved } = await load()
  const r = removeById([p(1), p(2)], 1)
  const there = [p(1), p(2)]
  t.is(restoreRemoved(there, r.removed), there, 'already present')
  const full = [p(2), p(3)]
  t.is(restoreRemoved(full, r.removed, 2), full, 'full list')
  t.is(restoreRemoved(full, null), full)
  t.is(restoreRemoved(full, { item: p(5), index: 'x' }), full)
})
