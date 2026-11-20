'use strict'

// Pure scroll decision for the A Rua bars (src/chromeScroll.js).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/chromeScroll.js')
const U = { userScrolled: true }

function run (M, state, ys, extra = {}) {
  for (const y of ys) state = M.nextChrome(state, { y, ...U, ...extra })
  return state
}

test('bounce never hides', async (t) => {
  const M = await load()
  let s = M.initialChrome()
  s = run(M, s, [-5, -40, -80])
  t.is(s.hidden, false)
  const h = { hidden: true, anchorY: 100 }
  t.is(M.nextChrome(h, { y: -10, ...U }).hidden, false)
})

test('resize-only and programmatic frames neither hide nor show', async (t) => {
  const M = await load()
  const s = run(M, M.initialChrome(), [100, 300, 600], { userScrolled: false })
  t.is(s.hidden, false)
  const h = run(M, { hidden: true, anchorY: 600 }, [400, 100, 50], { userScrolled: false })
  t.is(h.hidden, true)
})

test('hides after 24 pt past the top bar, not before', async (t) => {
  const M = await load()
  t.is(M.CHROME_HIDE_AFTER, 24)
  let s = run(M, { hidden: false, anchorY: 100, lastY: 100 }, [110, 123])
  t.is(s.hidden, false)
  s = M.nextChrome(s, { y: 124, ...U })
  t.is(s.hidden, true)
  // 24 pt of travel but still inside the top bar
  s = run(M, { hidden: false, anchorY: 20, lastY: 20 }, [30, 44])
  t.is(s.hidden, false)
  s = M.nextChrome(s, { y: 53, ...U })
  t.is(s.hidden, true)
})

test('shows after 8 pt upward', async (t) => {
  const M = await load()
  t.is(M.CHROME_SHOW_AFTER, 8)
  let s = run(M, { hidden: true, anchorY: 300, lastY: 300 }, [295, 293])
  t.is(s.hidden, true)
  s = M.nextChrome(s, { y: 292, ...U })
  t.is(s.hidden, false)
})

test('a direction change re-anchors at the turning point', async (t) => {
  const M = await load()
  let s = run(M, { hidden: false, anchorY: 100, lastY: 100 }, [120])
  t.is(s.hidden, false)
  s = run(M, s, [115, 130, 138])
  t.is(s.hidden, false)
  s = M.nextChrome(s, { y: 139, ...U })
  t.is(s.hidden, true)
  s = M.chromeGesture(s)
  s = run(M, s, [150, 143])
  t.is(s.hidden, true)
  s = run(M, s, [140, 130])
  t.is(s.hidden, false)
})

test('y <= 0 shows', async (t) => {
  const M = await load()
  const s = M.nextChrome({ hidden: true, anchorY: 200 }, { y: 0, ...U })
  t.alike({ hidden: s.hidden, anchorY: s.anchorY }, { hidden: false, anchorY: 0 })
})

test('reduceMotion and screenReader always show', async (t) => {
  const M = await load()
  for (const extra of [{ reduceMotion: true }, { screenReader: true }]) {
    const s = run(M, { hidden: true, anchorY: 100 }, [200, 400, 800], extra)
    t.is(s.hidden, false)
    t.is(s.anchorY, 800)
  }
})

test('non-finite y is ignored', async (t) => {
  const M = await load()
  const s0 = { hidden: true, anchorY: 90 }
  for (const y of [NaN, Infinity, -Infinity, undefined]) {
    t.is(M.nextChrome(s0, { y, ...U }), s0)
  }
})

test('never hides with less room below than the list would gain', async (t) => {
  const M = await load()
  // 30 pt left under the viewport and 52 pt of bars: hiding would clamp the offset
  t.is(run(M, { hidden: false, anchorY: 100 }, [130, 160], { below: 30, grow: 52 }).hidden, false)
  t.is(run(M, { hidden: false, anchorY: 100 }, [130, 160], { below: 52, grow: 52 }).hidden, true, 'exactly enough room hides')
  t.is(run(M, { hidden: true, anchorY: 100 }, [130, 160], { below: 0, grow: 52 }).hidden, true, 'already hidden stays hidden at the end')
  t.is(run(M, { hidden: false, anchorY: 100 }, [130, 160], { below: NaN, grow: 52 }).hidden, true, 'unknown room hides as before')
})

test('after a flip the rest of the gesture only moves the anchor', async (t) => {
  const M = await load()
  // the hide, then the list sliding up under a finger that stays put
  let s = run(M, { hidden: false, anchorY: 100, lastY: 100 }, [130])
  t.is(s.hidden, true)
  s = run(M, s, [120, 100, 80])
  t.is(s.hidden, true, 'the shift does not show them')
  t.is(s.anchorY, 80, 'it only moves the anchor')
  s = M.chromeGesture(s)
  t.is(run(M, s, [76]).hidden, true)
  s = run(M, s, [76, 72])
  t.is(s.hidden, false, 'a new gesture up shows them after 8 pt')
  // the show slides the list down under the finger
  s = run(M, s, [90, 125, 130])
  t.is(s.hidden, false, 'the shift does not hide them again')
  s = run(M, M.chromeGesture(s), [150, 160])
  t.is(s.hidden, true)
  // showing at the top holds too
  s = run(M, { hidden: true, anchorY: 200, lastY: 10 }, [0, 40, 90])
  t.is(s.hidden, false, 'the shift after the top does not hide them')
  t.is(run(M, M.chromeGesture(s), [100, 130]).hidden, true)
  const plain = { hidden: false, anchorY: 50 }
  t.is(M.chromeGesture(plain), plain, 'a gesture without a hold changes nothing')
})

test('focus on a hidden bar shows them and holds', async (t) => {
  const M = await load()
  const shown = { hidden: false, anchorY: 40 }
  t.is(M.chromeShow(shown), shown, 'already shown changes nothing')
  let s = run(M, { hidden: false, anchorY: 100, lastY: 100 }, [130])
  t.is(s.hidden, true)
  s = M.chromeShow(s)
  t.alike({ hidden: s.hidden, anchorY: s.anchorY, hold: s.hold }, { hidden: false, anchorY: 130, hold: true })
  t.is(run(M, s, [160]).hidden, false, 'the rest of that gesture does not hide them')
  t.is(run(M, M.chromeGesture(s), [150, 160]).hidden, true, 'the next gesture down does')
  t.is(M.chromeShow({ hidden: true, anchorY: 70 }).anchorY, 70, 'no lastY falls back to the anchor')
})

test('hidden props leave the accessibility tree everywhere and show on focus', async (t) => {
  const M = await load()
  const show = () => {}
  t.alike(M.chromeHiddenProps(show), { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', onFocus: show })
})

test('the first frame after a reset only anchors, wherever the feed sits', async (t) => {
  const M = await load()
  const fresh = M.chromeGesture(M.initialChrome())
  const opts = { userScrolled: true, top: 52, below: 5000, grow: 52 }
  t.is(M.nextChrome(fresh, { y: 499, ...opts }).hidden, false, 'a small move up from 500 does not hide')
  t.is(M.nextChrome(fresh, { y: 501, ...opts }).hidden, false, 'a small move down from 500 does not hide')
  t.is(run(M, fresh, [501, 520, 530], { below: 5000, grow: 52 }).hidden, true, 'travel from that frame still hides')
})

test('rows merged above are not a scroll by the person', async (t) => {
  const M = await load()
  t.is(M.contentShift({ y: 700, lastY: 500, grew: 200 }), true, 'the offset moved by what was added')
  t.is(M.contentShift({ y: 650, lastY: 500, grew: 200.4 }), true, 'or by less')
  t.is(M.contentShift({ y: 700.8, lastY: 500, grew: 200 }), true, 'within a point of rounding')
  t.is(M.contentShift({ y: 760, lastY: 500, grew: 200 }), false, 'more than that is the person too')
  t.is(M.contentShift({ y: 480, lastY: 500, grew: 200 }), false, 'a move up still counts')
  t.is(M.contentShift({ y: 530, lastY: 500, grew: 0 }), false, 'no growth')
  t.is(M.contentShift({ y: 530, lastY: 500, grew: -40 }), false, 'rows removed while the offset goes down')
  t.is(M.contentShift({ y: 456, lastY: 500, grew: -44 }), true, 'rows removed above pull the offset up by their height')
  t.is(M.contentShift({ y: 400, lastY: 500, grew: -44 }), false, 'more than that up is the person')
  t.is(M.contentShift({ y: 530, lastY: 500, grew: NaN }), false, 'unknown growth')
  t.is(M.contentShift({ y: 530, lastY: undefined, grew: 200 }), false, 'no frame yet')
})

test('chromeMotion defaults to shown', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/chromeMotion.js'), 'utf8')
  t.ok(/new Animated\.Value\(0\)/.test(src))
  t.ok(/hidden: false/.test(src))
  t.ok(/show \(\) \{\}/.test(src), 'a show that does nothing outside the provider')
  t.ok(/createContext\(DEFAULT\)/.test(src))
  t.ok(/export function useChromeMotion/.test(src))
})
