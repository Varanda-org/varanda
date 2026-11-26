'use strict'

const test = require('brittle')
const load = () => import('../src/media/prefetch.js')
const descriptor = start => Object.freeze({ core: 'a'.repeat(64), start, blocks: 1, bytes: 1000, sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 100, height: 100 })
const rows = Object.freeze(Array.from({ length: 12 }, (_, i) => Object.freeze({ media: Object.freeze([descriptor(i)]) })))

test('prefetch starts after the last visible row and defaults to six rows', async t => {
  const { planPrefetch } = await load()
  t.alike(planPrefetch({ rows, lastVisible: 2 }), rows.slice(3, 9).flatMap(row => row.media))
  t.alike(planPrefetch({ rows, lastVisible: -1, ahead: 2 }), [rows[0].media[0], rows[1].media[0]])
})

test('prefetch caps descriptors even within a single row', async t => {
  const { planPrefetch } = await load()
  const media = rows.flatMap(row => row.media)
  t.alike(planPrefetch({ rows: [{ media }], lastVisible: -1 }), media.slice(0, 8))
  for (const max of [0, 1, 3, 8, 20]) {
    const plan = planPrefetch({ rows: [{ media }], lastVisible: -1, max })
    t.ok(plan.length <= max)
    t.alike(plan, media.slice(0, max))
  }
})

test('prefetch deduplicates descriptor values regardless of property order', async t => {
  const { planPrefetch } = await load()
  const a = descriptor(0)
  const copy = Object.fromEntries(Object.entries(a).reverse())
  const b = descriptor(1)
  const otherCore = { ...a, core: 'c'.repeat(64) }
  const input = [{ media: [a, a, copy] }, { media: [copy, b, otherCore, b] }]
  const plan = planPrefetch({ rows: input, lastVisible: -1, max: 3 })
  t.alike(plan, [a, b, otherCore])
  t.is(plan[0], a)
  t.is(plan.length, new Set(plan).size)
})

test('empty rows count toward ahead and list boundaries stop the plan', async t => {
  const { planPrefetch } = await load()
  const a = descriptor(0)
  const input = [null, {}, { media: null }, { media: [null, a] }]
  t.alike(planPrefetch({ rows: input, lastVisible: -1, ahead: 3 }), [])
  t.alike(planPrefetch({ rows: input, lastVisible: -1, ahead: 4 }), [a])
  t.alike(planPrefetch({ rows, lastVisible: 10 }), rows[11].media)
  t.alike(planPrefetch({ rows, lastVisible: 11 }), [])
  t.alike(planPrefetch({ rows: [], lastVisible: -1 }), [])
  t.alike(planPrefetch({ rows, lastVisible: 0, ahead: 0 }), [])
  t.alike(planPrefetch({ rows, lastVisible: 0, ahead: -1 }), [])
  t.alike(planPrefetch({ rows, lastVisible: 0, max: -1 }), [])
})

test('prefetch keeps inputs intact and returns a fresh plan', async t => {
  const { planPrefetch } = await load()
  const args = Object.freeze({ rows, lastVisible: 0 })
  const first = planPrefetch(args)
  first.pop()
  t.alike(planPrefetch(args), rows.slice(1, 7).flatMap(row => row.media))
  t.is(rows.length, 12)
})

test('prefetch: odd window inputs fall back, and clips are never planned', async t => {
  const { planPrefetch } = await load()
  t.alike(planPrefetch({ rows, lastVisible: null, ahead: 1 }), [rows[0].media[0]], 'null means nothing visible yet')
  t.alike(planPrefetch({ rows, lastVisible: undefined, ahead: 1 }), [rows[0].media[0]])
  t.alike(planPrefetch({ rows, lastVisible: 1.5, ahead: 1 }), [rows[2].media[0]], 'a fraction is floored')
  t.alike(planPrefetch({ rows, lastVisible: 2, ahead: null }), rows.slice(3, 9).flatMap(row => row.media), 'null ahead is the default')
  t.alike(planPrefetch({ rows, lastVisible: -1, ahead: 1, max: NaN }), [rows[0].media[0]], 'NaN max is the default')
  const clip = Object.freeze({ ...descriptor(50), mime: 'video/mp4' })
  t.alike(planPrefetch({ rows: [{ media: [descriptor(40), clip] }], lastVisible: -1 }), [descriptor(40)], 'the poster only')
  t.alike(planPrefetch({ rows: null, lastVisible: 0 }), [])
})
