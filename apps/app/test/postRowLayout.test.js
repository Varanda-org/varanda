'use strict'

// A post row renders once on mount (src/postRowLayout.js and its use in
// PostRow and ClampText).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/postRowLayout.js')
const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')

test('a caption measured at the estimate stores nothing', async (t) => {
  const { captionWidthNext } = await load()
  t.is(captionWidthNext(300, 300), undefined)
  t.is(captionWidthNext(300, 300.4), undefined, 'sub-point jitter')
  t.is(captionWidthNext(300, 280), 280, 'a real difference is stored')
  t.is(captionWidthNext(300, 0), undefined)
  t.is(captionWidthNext(300, NaN), undefined)
  const src = read('ui/PostRow.js')
  t.ok(src.includes('captionWidthNext(captionEstimate(windowWidth)'), 'the row compares with the clamp estimate')
  t.absent(/^\s*setCaptionWidth\(/m.test(src.replace(/if \(next !== captionWidth\) setCaptionWidth\(next\)/, '')), 'no unconditional setCaptionWidth')
})

test('the head reserve is seeded once from the last measured row', async (t) => {
  const { headActionsKey, headReserveOf, rememberHeadActions, cachedHeadActions, seedHeadActions } = await load()
  const guess = { width: 108, height: 44 }
  const key = headActionsKey(true, true, 1.3)
  t.alike(headReserveOf({ key, measured: null, seeded: seedHeadActions(null, key), guess }), guess, 'nothing measured yet')
  rememberHeadActions(key, { width: 120, height: 52 })
  const seeded = seedHeadActions(null, key)
  t.alike(headReserveOf({ key, measured: null, seeded, guess }), { width: 120, height: 52 }, 'a new row starts with the cached size')
  rememberHeadActions(key, { width: 140, height: 52 })
  t.is(seedHeadActions(seeded, key), seeded, 'the row keeps its seed')
  t.alike(headReserveOf({ key, measured: null, seeded, guess }), { width: 120, height: 52 }, 'a later write by another row does not move it')
  rememberHeadActions(key, { width: 140.3, height: 51.8 })
  t.alike(cachedHeadActions(key), { width: 140, height: 52 }, 'the cache ignores sub-point rounding')
  t.is(cachedHeadActions(headActionsKey(true, false, 1.3)), null, 'other buttons keep their own size')
  t.is(cachedHeadActions(headActionsKey(true, true, 1)), null, 'another text size keeps its own')
  t.alike(headReserveOf({ key, measured: { key, width: 90, height: 44 }, seeded, guess }), { width: 90, height: 44 }, 'the row\'s own measure wins')
  t.alike(headReserveOf({ key, measured: { key: 'x', width: 90, height: 44 }, seeded, guess }), { width: 120, height: 52 }, 'a measure of other buttons is ignored')
  const src = read('ui/PostRow.js')
  t.ok(src.includes('if (sameSize(headReserve, { width, height })) return'), 'a reserved size is not stored again')
  t.ok(src.includes('headSeed.current = seedHeadActions(headSeed.current, headKey)') && src.includes('seeded: headSeed.current,'), 'seeded once per row and key')
  t.ok(src.includes('rememberHeadActions(headKey'))
})

test('head sizes under half a point apart are the same', async (t) => {
  const { sameSize } = await load()
  t.ok(sameSize({ width: 43.81, height: 43.81 }, { width: 44.19, height: 44.19 }), 'Android pixel rounding')
  t.absent(sameSize({ width: 43, height: 44 }, { width: 44, height: 44 }))
  t.absent(sameSize({ width: 44, height: 43 }, { width: 44, height: 44 }))
  t.absent(sameSize(null, { width: 44, height: 44 }))
  t.absent(sameSize({ width: 44, height: 44 }, undefined))
})

test('sheets mount on first open and stay mounted', async (t) => {
  const { openedNext } = await load()
  const none = null
  t.is(openedNext(none, null), none)
  const a = openedNext(none, 'more')
  t.alike(a, { more: true })
  t.is(openedNext(a, 'more'), a, 'same object, no render')
  t.is(openedNext(a, null), a, 'closing keeps it mounted')
  t.alike(openedNext(a, 'repost'), { more: true, repost: true })
  const src = read('ui/PostRow.js')
  t.ok(src.includes("{opened && opened.repost ? <ActionsSheet open={sheet === 'repost'}"), 'repost sheet gated')
  t.ok(src.includes("{opened && opened.more ? <ActionsSheet open={sheet === 'more'}"), 'more sheet gated')
  t.is(src.split('<ActionsSheet').length - 1, 2)
  t.ok(src.includes('if (sheet !== null && openedNext(opened, sheet) !== opened) setOpened(openedNext(opened, sheet))'), 'opening a sheet marks it opened')
})

test('the row reads reduced motion from the shared store', (t) => {
  const src = read('ui/PostRow.js')
  t.absent(src.includes('AccessibilityInfo'), 'no module listener of its own')
  t.ok(src.includes('const reduceMotionOn = useReduceMotion()'))
  t.ok(src.includes('if (perfOn) usePerfRow('), 'perf row counter kept')
})
