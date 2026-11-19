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

test('a head too narrow for the date beside its targets stacks', async (t) => {
  const { headStacks } = await load()
  // 100 pt of header padding; 120 pt of targets: the "seguir" pill (68 pt
  // until measured), the menu's 44, and the 8 pt before the pill.
  const at = (width, time, handle = true) => headStacks({ room: width - 100, reserve: 120, handle, time, fontSize: 13, fontScale: 1 })
  t.ok(at(320, '31 dez 2025'), 'a 320 pt row with a handle stacks a date with the year')
  t.absent(at(375, '31 dez 2025'), 'it fits at 375 pt')
  t.absent(at(320, '31 dez'), 'a date without the year fits at 320 pt')
  t.absent(at(320, '31 dez 2025', false), 'without a handle the date fits at 320 pt')
  t.absent(headStacks({ room: 260, reserve: 120, handle: true, time: '31 dez 2025', fontSize: 13, fontScale: 1 }), 'it fits at 360 pt')
  t.ok(headStacks({ room: 260, reserve: 120, handle: true, time: '31 dez 2025', fontSize: 13, fontScale: 1.25 }), 'bigger text needs more room')
  t.absent(headStacks({ room: 0, reserve: 120, handle: true, time: '31 dez 2025', fontSize: 13, fontScale: 1 }), 'no width, no decision')
})

test('the post head stacks on a narrow row from the first render', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes('const HEAD_INSET = space.xl + 40 + space.md + space.xl') && src.includes('header: { paddingLeft: space.xl + 40 + space.md, paddingRight: space.xl,'), 'the inset is the header padding')
  t.ok(src.includes('const narrowHead = headActions && narrowAt(headWidth ?? windowWidth)'), 'the window decides the first render')
  t.ok(src.includes('<View style={styles.header} onLayout={headActions ? measureHead : undefined}>'), 'the header measures itself')
  t.ok(src.includes('narrowAt(width) !== narrowHead) setHeadWidth(width)'), 'only a different decision renders again')
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
  t.ok(src.includes("{host === null && opened && opened.repost ? <ActionsSheet open={sheet === 'repost'}"), 'repost sheet gated, and only without a list sheet host')
  t.ok(src.includes("{host === null && opened && opened.more ? <ActionsSheet open={sheet === 'more'}"), 'more sheet gated, and only without a list sheet host')
  t.is(src.split('<ActionsSheet').length - 1, 2)
  t.ok(src.includes('if (sheet !== null && openedNext(opened, sheet) !== opened) setOpened(openedNext(opened, sheet))'), 'opening a sheet marks it opened')
})

test('the row reads reduced motion from the shared store', (t) => {
  const src = read('ui/PostRow.js')
  t.absent(src.includes('AccessibilityInfo'), 'no module listener of its own')
  t.ok(src.includes('const reduceMotionOn = useReduceMotion()'))
  t.ok(src.includes('if (perfOn) usePerfRow('), 'perf row counter kept')
})
