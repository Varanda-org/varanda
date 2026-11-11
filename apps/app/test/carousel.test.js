'use strict'

// Carousel math stays usable without a browser, filesystem or React Native.
const test = require('brittle')
const load = () => import('../src/carousel.js')

test('frameRatio clamps portrait and panorama and keeps 4:3', async (t) => {
  const { FRAME_RATIO_MIN, FRAME_RATIO_MAX, frameRatio } = await load()
  t.is(FRAME_RATIO_MIN, 0.8)
  t.is(FRAME_RATIO_MAX, 1.91)
  t.is(frameRatio([{ width: 1, height: 3 }]), FRAME_RATIO_MIN, '1:3 portrait')
  t.is(frameRatio([{ width: 3, height: 1 }]), FRAME_RATIO_MAX, '3:1 panorama')
  t.is(frameRatio([{ width: 4, height: 3 }]), 4 / 3, '4:3 stays')
  t.is(frameRatio([{ width: 4, height: 5 }]), 4 / 5, '4:5 is the portrait bound')
  t.is(frameRatio([{ width: 191, height: 100 }]), 191 / 100, '1.91:1 is the landscape bound')
  t.is(frameRatio([{ width: 1080, height: 1080 }]), 1)
  t.is(frameRatio([{ width: 4, height: 3 }, { width: 1, height: 30 }]), 4 / 3, 'only the first photo')
})

test('frameRatio returns 1 for empty, non-array, or unusable sizes', async (t) => {
  const { frameRatio } = await load()
  for (const media of [null, undefined, [], {}, 'photos', 0, 4, [null], [undefined], [0], ['photo']]) {
    t.is(frameRatio(media), 1)
  }
  for (const photo of [
    {},
    { width: 100 },
    { height: 100 },
    { width: 0, height: 100 },
    { width: 100, height: 0 },
    { width: -4, height: 3 },
    { width: 4, height: -3 },
    { width: NaN, height: 3 },
    { width: 4, height: NaN },
    { width: Infinity, height: 3 },
    { width: 4, height: Infinity },
    { width: '4', height: 3 },
    { width: 4, height: '3' }
  ]) {
    t.is(frameRatio([photo]), 1)
  }
})

test('pageAt snaps half-page boundaries and clamps the scroll', async (t) => {
  const { pageAt } = await load()
  const width = 300
  const count = 4
  t.is(pageAt(0, width, count), 0)
  t.is(pageAt(149, width, count), 0, 'just under half a page stays')
  t.is(pageAt(150, width, count), 1, 'exact half rounds to the next page')
  t.is(pageAt(151, width, count), 1, 'just over half a page advances')
  t.is(pageAt(449, width, count), 1)
  t.is(pageAt(450, width, count), 2)
  t.is(pageAt(451, width, count), 2)
  t.is(pageAt(900, width, count), 3, 'last page')
  t.is(pageAt(1050, width, count), 3, 'half a page past the end clamps')
  t.is(pageAt(1200, width, count), 3, 'overscrolled offset clamps')
  t.is(pageAt(-1, width, count), 0)
  t.is(pageAt(-149, width, count), 0)
  t.is(pageAt(-151, width, count), 0, 'negative page clamps to 0')
  t.is(pageAt(-900, width, count), 0)
})

test('pageAt returns 0 for a bad width, offset, or count, including count 1', async (t) => {
  const { pageAt } = await load()
  t.is(pageAt(0, 300, 1), 0)
  t.is(pageAt(149, 300, 1), 0)
  t.is(pageAt(151, 300, 1), 0)
  t.is(pageAt(750, 300, 1), 0)
  t.is(pageAt(-151, 300, 1), 0)
  for (const width of [0, -300, NaN, Infinity, -Infinity]) t.is(pageAt(151, width, 4), 0)
  for (const offsetX of [NaN, Infinity, -Infinity]) t.is(pageAt(offsetX, 300, 4), 0)
  for (const count of [0, -1, 1.5, NaN, Infinity, '4']) t.is(pageAt(151, 300, count), 0)
})

test('offsetOf is index times width, else 0', async (t) => {
  const { offsetOf } = await load()
  t.is(offsetOf(0, 300), 0)
  t.is(offsetOf(1, 300), 300)
  t.is(offsetOf(3, 320), 960)
  for (const index of [-1, -0.5, NaN, Infinity, -Infinity]) t.is(offsetOf(index, 300), 0)
  for (const width of [0, -1, NaN, Infinity, -Infinity]) t.is(offsetOf(2, width), 0)
})

test('stepIndex stops at both ends and on a single photo', async (t) => {
  const { stepIndex } = await load()
  t.is(stepIndex(1, 1, 4), 2)
  t.is(stepIndex(2, -1, 4), 1)
  t.is(stepIndex(0, -1, 4), 0, 'start does not wrap')
  t.is(stepIndex(0, -5, 4), 0)
  t.is(stepIndex(3, 1, 4), 3, 'end does not wrap')
  t.is(stepIndex(3, 5, 4), 3)
  t.is(stepIndex(0, 10, 4), 3)
  t.is(stepIndex(3, -10, 4), 0)
  t.is(stepIndex(0, 0, 1), 0)
  t.is(stepIndex(0, 1, 1), 0, 'count 1 cannot advance')
  t.is(stepIndex(0, -1, 1), 0, 'count 1 cannot go back')
  t.is(stepIndex(-1, 3, 4), 2, 'sum is clamped, a negative index is not rejected')
  for (const args of [
    [NaN, 1, 4],
    [1, NaN, 4],
    [Infinity, 1, 4],
    [1, Infinity, 4],
    [1, -Infinity, 4],
    [1, 1, 0],
    [1, 1, -1],
    [1, 1, 1.5],
    [1, 1, NaN],
    ['1', 1, 4],
    [1, '1', 4]
  ]) t.is(stepIndex(...args), 0)
})

test('shouldMount keeps the open page and a radius of neighbors', async (t) => {
  const { shouldMount } = await load()
  t.is(shouldMount(2, 2), true)
  t.is(shouldMount(1, 2), true)
  t.is(shouldMount(3, 2), true)
  t.is(shouldMount(0, 2), false)
  t.is(shouldMount(4, 2), false)
  t.is(shouldMount(0, 2, 2), true)
  t.is(shouldMount(4, 2, 2), true)
  t.is(shouldMount(5, 2, 2), false)
  t.is(shouldMount(2, 2, 0), true)
  t.is(shouldMount(3, 2, 0), false)
  t.is(shouldMount(3, 2, 1), true, 'explicit radius of 1 matches the default')
  t.is(shouldMount(4, 2, 1), false)
})

test('counterText and slideLabel use the viewer strings', async (t) => {
  const { counterText, slideLabel } = await load()
  t.is(counterText(1, 4), '2 de 4')
  t.is(counterText(0, 4), '1 de 4')
  t.is(counterText(3, 4), '4 de 4')
  t.is(slideLabel(1, 4), 'foto 2 de 4')
  t.is(slideLabel(0, 4), 'foto 1 de 4')
  t.is(slideLabel(3, 4), 'foto 4 de 4')
})
