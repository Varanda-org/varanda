'use strict'

const test = require('brittle')
const load = () => import('../src/media/frame.js')

test('FRAMES lists the three immutable frame options in display order', async (t) => {
  const { FRAMES } = await load()
  t.alike(FRAMES, [
    { id: 'portrait', label: 'Retrato', ratio: 4 / 5 },
    { id: 'square', label: 'Quadrado', ratio: 1 },
    { id: 'landscape', label: 'Paisagem', ratio: 16 / 9 }
  ])
  t.ok(Object.isFrozen(FRAMES))
  for (const frame of FRAMES) t.ok(Object.isFrozen(frame))
})

test('frameOf uses explicit cut points and keeps 4:3 square', async (t) => {
  const { PORTRAIT_BELOW, LANDSCAPE_ABOVE, FRAMES, frameOf } = await load()
  const [portrait, square, landscape] = FRAMES
  t.is(PORTRAIT_BELOW, 0.9)
  t.is(LANDSCAPE_ABOVE, 1.34)
  for (const [width, height, frame] of [
    [4032, 3024, square],
    [2048, 1536, square],
    [1365, 1024, square],
    [1000, 749, square],
    [3024, 4032, portrait],
    [1080, 1920, portrait],
    [1920, 1080, landscape],
    [3000, 2000, landscape],
    [1638, 2048, portrait],
    [2048, 2048, square],
    [2048, 1152, landscape],
    [899, 1000, portrait],
    [900, 1000, square],
    [1340, 1000, square],
    [1341, 1000, landscape]
  ]) t.is(frameOf(width, height), frame, `${width}x${height} is ${frame.id}`)
})

test('frameById resolves the shared options and returns null for unknown ids', async (t) => {
  const { FRAMES, frameById } = await load()
  for (const frame of FRAMES) t.is(frameById(frame.id), frame)
  for (const id of ['wide', 'Portrait', '', null, undefined, 1, {}]) t.is(frameById(id), null)
})

test('postFrame uses the first item and defaults to square if it is unusable', async (t) => {
  const { FRAMES, postFrame } = await load()
  const [portrait, square, landscape] = FRAMES
  const tall = { width: 3, height: 4 }
  const wide = { width: 16, height: 9 }
  t.is(postFrame([tall, wide]), portrait)
  t.is(postFrame([wide, tall]), landscape)
  for (const media of [null, undefined, [], tall, { 0: tall }, [null, tall], [{ width: 4 }, wide], [undefined, tall]]) {
    t.is(postFrame(media), square)
  }
})

test('fitInFrame covers when at least 80 percent of the image stays visible', async (t) => {
  const { COVER_MIN, fitInFrame } = await load()
  t.is(COVER_MIN, 0.8)
  for (const [width, height, ratio, fit] of [
    [3, 4, 4 / 5, 'cover'],
    [4, 3, 1, 'contain'],
    [9, 16, 4 / 5, 'contain'],
    [3, 2, 16 / 9, 'cover'],
    [3, 1, 16 / 9, 'contain'],
    [4, 5, 1, 'cover'],
    [799, 1000, 1, 'contain']
  ]) t.is(fitInFrame({ width, height }, ratio), fit, `${width}x${height} in ${ratio} uses ${fit}`)
  t.is(fitInFrame({}, 1), 'cover')
  t.is(fitInFrame({ width: 3, height: 1 }, 0), 'cover')
})

test('frame policy returns fallbacks for garbage input', async (t) => {
  const { FRAMES, frameOf, frameById, postFrame, fitInFrame } = await load()
  const [, square] = FRAMES
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  const throwingSize = { get width () { throw new Error('unreadable width') } }
  const wide = { width: 3, height: 1 }

  for (const value of [undefined, null, '4', NaN, Infinity, -Infinity, -1, 0, {}, Symbol('size'), 4n, revoked.proxy, throwingSize]) {
    t.is(frameOf(value, 1), square)
    t.is(frameOf(1, value), square)
    t.is(frameById(value), null)
    t.is(postFrame(value), square)
    t.is(postFrame([value]), square)
    t.is(postFrame([{ width: value, height: 1 }]), square)
    t.is(fitInFrame(value, 1), 'cover')
    t.is(fitInFrame({ width: value, height: 1 }, 1), 'cover')
    t.is(fitInFrame(wide, value), 'cover')
  }
})
