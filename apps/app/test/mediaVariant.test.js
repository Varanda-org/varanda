'use strict'

const test = require('brittle')
const load = () => import('../src/media/variant.js')
const full = Object.freeze({ core: 'a'.repeat(64), start: 0, blocks: 2, bytes: 40000, sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 1200, height: 800 })
const thumb = Object.freeze({ ...full, start: 2, blocks: 1, bytes: 10000, sha256: 'c'.repeat(64), width: 640, height: 427 })
const media = Object.freeze([full, full])

test('old posts and null thumbnails pick full size', async t => {
  const { pickVariant } = await load()
  for (const thumbs of [undefined, null, [], [null]]) {
    t.alike(pickVariant({ media, thumbs, index: 0, widthPx: 320, dpr: 2 }), [full])
  }
})

test('thumbnail comes first up to and including 640 physical pixels', async t => {
  const { pickVariant } = await load()
  const thumbs = Object.freeze([thumb, null])
  for (const [widthPx, dpr] of [[320, 1], [320, 2], [640, 1], [160, 4]]) {
    const order = pickVariant({ media, thumbs, index: 0, widthPx, dpr })
    t.is(order[0], thumb)
    t.is(order[1], full)
    t.is(order.length, 2)
  }
})

test('larger physical widths pick full size', async t => {
  const { pickVariant } = await load()
  for (const [widthPx, dpr] of [[321, 2], [640, 2], [641, 1]]) {
    t.alike(pickVariant({ media, thumbs: [thumb, null], index: 0, widthPx, dpr }), [full])
  }
})

test('thumbnail selection preserves index alignment and inputs', async t => {
  const { pickVariant } = await load()
  const thumbs = Object.freeze([null, thumb])
  const args = Object.freeze({ media, thumbs, index: 1, widthPx: 320, dpr: 1 })
  const order = pickVariant(args)
  t.alike(order, [thumb, full])
  order.pop()
  t.alike(pickVariant(args), [thumb, full])
  t.alike(pickVariant({ ...args, index: 0 }), [full])
})

test('the reader rule: misaligned lists, video pairs and non-still slots pick full size', async t => {
  const { pickVariant } = await load()
  t.alike(pickVariant({ media, thumbs: [thumb], index: 0, widthPx: 320, dpr: 2 }), [full], 'thumbs shorter than media')
  const poster = full
  const clip = Object.freeze({ ...full, mime: 'video/mp4' })
  t.alike(pickVariant({ media: [poster, clip], thumbs: [thumb, null], index: 0, widthPx: 320, dpr: 1 }), [poster], 'a video pair never uses a thumbnail')
  t.alike(pickVariant({ media: [clip], thumbs: [thumb], index: 0, widthPx: 320, dpr: 1 }), [clip], 'a clip slot')
  t.alike(pickVariant({ media, thumbs: [thumb, null], index: 0, widthPx: NaN, dpr: 1 }), [full], 'unknown width')
})
