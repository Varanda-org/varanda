// Optimistic like/repost state and index counts (engagement.js).
'use strict'

const test = require('brittle')
const load = () => import('../src/engagement.js')

const R1 = 'ab'.repeat(32) + ':1'
const R2 = 'cd'.repeat(32) + ':2'

test('applyToggle returns a new state and never mutates', async (t) => {
  const { emptyState, applyToggle, fromRead } = await load()
  const s0 = emptyState()
  const s1 = applyToggle(s0, 'like', R1, true)
  t.ok(s1.liked.has(R1))
  t.is(s0.liked.size, 0, 'input untouched')
  const s2 = applyToggle(s1, 'repost', R1, true)
  t.ok(s2.reposted.has(R1) && s2.liked.has(R1))
  t.not(s2.liked, s1.liked, 'sets are copies')
  const s3 = applyToggle(s2, 'like', R1, false)
  t.absent(s3.liked.has(R1))
  t.ok(s2.liked.has(R1))
  t.is(applyToggle(s3, 'curtir', R1, true), s3, 'unknown kind')
  const read = fromRead({ liked: [R1, 5], reposted: [R2] })
  t.alike([...read.liked], [R1])
  t.alike([...read.reposted], [R2])
  t.is(fromRead(null).liked.size, 0)
})

test('countsAfter never goes below 0 and null stays null', async (t) => {
  const { countsAfter } = await load()
  const c = Object.freeze({ replies: 1, likes: 0, reposts: 2, quotes: 0 })
  t.alike(countsAfter(c, 'like', 1), { replies: 1, likes: 1, reposts: 2, quotes: 0 })
  t.alike(countsAfter(c, 'like', -1), { ...c, likes: 0 })
  t.alike(countsAfter(c, 'repost', -1), { ...c, reposts: 1 })
  t.is(countsAfter(null, 'like', 1), null)
  t.is(countsAfter(c, 'quote', 1), c)
})

test('mergeCounts lets the fetched counts win', async (t) => {
  const { mergeCounts } = await load()
  const a = { replies: 0, likes: 1, reposts: 0, quotes: 0 }
  const b = { replies: 3, likes: 2, reposts: 0, quotes: 0 }
  const map = new Map([[R1, a]])
  const merged = mergeCounts(map, { [R1]: b, [R2]: a })
  t.is(merged.get(R1), b)
  t.is(merged.get(R2), a)
  t.is(map.get(R1), a, 'input untouched')
  t.is(mergeCounts(map, new Map([[R2, b]])).get(R2), b)
  t.is(mergeCounts(null, null).size, 0)
})
