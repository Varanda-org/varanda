'use strict'

// Photo order stays usable without a browser, filesystem or React Native.
const test = require('brittle')
const load = () => import('../src/photoOrder.js')

function photo (id, status = 'ready') {
  return Object.freeze({
    id,
    status,
    descriptor: Object.freeze({ hash: id }),
    thumb: 'blob:' + id
  })
}

test('moveItem moves a photo forward or backward', async (t) => {
  const { moveItem } = await load()
  const a = photo('a', 'ready')
  const b = photo('b', 'encoding')
  const c = photo('c', 'uploading')
  const d = photo('d', 'failed')
  const list = [a, b, c, d]
  const forward = moveItem(list, 1, 3)
  t.alike(forward.map((item) => item.id), ['a', 'c', 'd', 'b'])
  t.is(forward[0], a)
  t.is(forward[1], c)
  t.is(forward[2], d)
  t.is(forward[3], b)
  t.is(forward[3].status, 'encoding')
  t.is(forward[3].descriptor, b.descriptor)
  t.is(forward[3].thumb, b.thumb)
  const backward = moveItem(list, 3, 0)
  t.alike(backward.map((item) => item.id), ['d', 'a', 'b', 'c'])
  t.is(backward[0], d)
  t.is(backward[1], a)
  t.is(backward[2], b)
  t.is(backward[3], c)
  t.is(backward[0].id, 'd')
  t.is(backward[0].status, 'failed')
  t.is(backward[0].descriptor, d.descriptor)
  t.is(backward[0].thumb, d.thumb)
  t.not(forward, list)
  t.not(backward, list)
})

test('moveItem swaps the first with the second and the last with the previous', async (t) => {
  const { moveItem } = await load()
  const a = photo('a', 'ready')
  const b = photo('b', 'encoding')
  const c = photo('c', 'failed')
  const list = [a, b, c]
  const secondFirst = moveItem(list, 0, 1)
  t.alike(secondFirst.map((item) => item.id), ['b', 'a', 'c'])
  t.is(secondFirst[0], b)
  t.is(secondFirst[1], a)
  t.is(secondFirst[2], c)
  const firstSecond = moveItem(list, 1, 0)
  t.alike(firstSecond.map((item) => item.id), ['b', 'a', 'c'])
  t.is(firstSecond[0], b)
  t.is(firstSecond[1], a)
  t.is(firstSecond[1].descriptor, a.descriptor)
  t.is(firstSecond[1].thumb, a.thumb)
  const lastBack = moveItem(list, 2, 1)
  t.alike(lastBack.map((item) => item.id), ['a', 'c', 'b'])
  t.is(lastBack[0], a)
  t.is(lastBack[1], c)
  t.is(lastBack[2], b)
  const previousForward = moveItem(list, 1, 2)
  t.alike(previousForward.map((item) => item.id), ['a', 'c', 'b'])
  t.is(previousForward[1], c)
  t.is(previousForward[2], b)
  t.is(previousForward[1].status, 'failed')
  t.is(previousForward[1].descriptor, c.descriptor)
  t.is(previousForward[1].thumb, c.thumb)
})

test('moveItem returns the same list when it cannot move', async (t) => {
  const { moveItem } = await load()
  const a = photo('a')
  const b = photo('b')
  const c = photo('c')
  const list = Object.freeze([a, b, c])
  for (const value of [null, undefined, { 0: a, length: 1 }, 'photos', 0]) {
    t.is(moveItem(value, 0, 1), value)
  }
  for (const [from, to] of [
    [1.5, 0],
    [0, 1.5],
    ['1', 0],
    [0, '1'],
    [NaN, 1],
    [1, NaN],
    [-1, 0],
    [0, -1],
    [-2, 1],
    [3, 0],
    [0, 3],
    [4, 1],
    [0, 0],
    [1, 1],
    [2, 2]
  ]) t.is(moveItem(list, from, to), list, String(from) + ' -> ' + String(to))
  const empty = []
  t.is(moveItem(empty, 0, 0), empty)
  t.is(moveItem(empty, -1, 0), empty)
  t.alike(list.map((item) => item.id), ['a', 'b', 'c'])
})

test('moveItem does not mutate the input and keeps each photo', async (t) => {
  const { moveItem } = await load()
  const a = photo('a', 'ready')
  const b = photo('b', 'encoding')
  const c = photo('c', 'uploading')
  const list = [a, b, c]
  const copy = list.slice()
  const next = moveItem(list, 0, 2)
  t.not(next, list)
  t.alike(list, copy)
  t.is(list[0], copy[0])
  t.is(list[1], copy[1])
  t.is(list[2], copy[2])
  t.alike(next.map((item) => item.id), ['b', 'c', 'a'])
  t.is(next[0], b)
  t.is(next[1], c)
  t.is(next[2], a)
  t.is(next[0].id, b.id)
  t.is(next[0].status, b.status)
  t.is(next[0].descriptor, b.descriptor)
  t.is(next[0].thumb, b.thumb)
  t.is(next[2].id, a.id)
  t.is(next[2].status, a.status)
  t.is(next[2].descriptor, a.descriptor)
  t.is(next[2].thumb, a.thumb)
})

test('moveById keeps moving the tapped photo when two taps share one render', async (t) => {
  const { moveById } = await load()
  const a = photo('a')
  const b = photo('b')
  const c = photo('c')
  const list = [a, b, c]
  // Two "antes" taps on c, both queued before the re-render.
  const twice = moveById(moveById(list, 'c', -1), 'c', -1)
  t.alike(twice.map((item) => item.id), ['c', 'a', 'b'])
  t.alike(moveById(list, 'a', 1).map((item) => item.id), ['b', 'a', 'c'])
  t.alike(list.map((item) => item.id), ['a', 'b', 'c'])
  t.is(moveById(list, 'a', -1), list)
  t.is(moveById(list, 'c', 1), list)
  t.is(moveById(list, 'z', 1), list)
  t.is(moveById(null, 'a', 1), null)
})
