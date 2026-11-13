'use strict'

// Carousel math stays usable without a browser or React Native.
// The wiring checks read MediaCarousel.js from disk.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
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

test('counterShown requires multiple measured slides and expires at the hold boundary', async (t) => {
  const { counterShown } = await load()
  t.is(counterShown({ many: true, measured: true, idleMs: 0 }), true, 'mount or page change')
  t.is(counterShown({ many: false, measured: true, idleMs: 0 }), false, 'one slide')
  t.is(counterShown({ many: true, measured: false, idleMs: 0 }), false, 'before layout')
  t.is(counterShown({ many: true, measured: true, idleMs: 1599 }), true)
  t.is(counterShown({ many: true, measured: true, idleMs: 1600 }), false)
  t.is(counterShown({ many: true, measured: true, idleMs: 2000 }), false)
  t.is(counterShown({ many: true, measured: true, idleMs: 49, hold: 50 }), true)
  t.is(counterShown({ many: true, measured: true, idleMs: 50, hold: 50 }), false)
  t.is(counterShown({ many: true, measured: true, idleMs: 0, hold: 0 }), false)
})

test('dotWindow slides around the current dot with an exclusive end', async (t) => {
  const { dotWindow } = await load()
  for (const count of [1, 5, 6, 20]) {
    t.alike(dotWindow(0, count), { start: 0, end: Math.min(5, count) }, 'first of ' + count)
    t.alike(dotWindow(count - 1, count), { start: Math.max(0, count - 5), end: count }, 'last of ' + count)
    for (let index = 0; index < count; index++) {
      const { start, end } = dotWindow(index, count)
      t.ok(start <= index && index < end, 'current dot stays visible')
      t.is(end - start, Math.min(count, 5), 'window stays full')
      t.ok(start >= 0 && end <= count, 'window stays in bounds')
    }
  }
  t.alike(dotWindow(2, 6), { start: 0, end: 5 })
  t.alike(dotWindow(3, 6), { start: 1, end: 6 })
  t.alike(dotWindow(10, 20), { start: 8, end: 13 })
  t.alike(dotWindow(10, 20, 3), { start: 9, end: 12 })
  t.alike(dotWindow(10, 20, 4), { start: 8, end: 12 })
  t.alike(dotWindow(10, 20, 1), { start: 10, end: 11 })
  t.alike(dotWindow(2, 5, 10), { start: 0, end: 5 })
})

test('dotWindow handles empty strips and clamps invalid indices', async (t) => {
  const { dotWindow } = await load()
  for (const count of [0, -1, 1.5, NaN, Infinity, '5']) {
    t.alike(dotWindow(0, count), { start: 0, end: 0 })
  }
  for (const max of [0, -1, 1.5, NaN, Infinity, '5']) {
    t.alike(dotWindow(0, 20, max), { start: 0, end: 0 })
  }
  for (const index of [-1, NaN, Infinity, '3']) {
    t.alike(dotWindow(index, 20), { start: 0, end: 5 })
  }
  t.alike(dotWindow(30, 20), { start: 15, end: 20 })
  t.alike(dotWindow(3.6, 20), { start: 2, end: 7 })
})

test('MediaCarousel fades the counter, windows the dots and opens chevrons on keyboard focus only', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/MediaCarousel.js'), 'utf8')
  const timerAt = src.indexOf('const timer = setTimeout(() => {')
  const reduceAt = src.indexOf('if (reduce) {')
  const hideAt = src.indexOf('counterOpacity.setValue(0)')
  const timingAt = src.indexOf('duration: motion.normal')
  const holdAt = src.indexOf('}, motion.hold)')
  t.ok(src.includes('const reduce = useReduceMotion()'), 'reduce motion comes from the hook')
  t.ok(src.includes('hold: motion.hold'), 'counterShown uses motion.hold')
  t.ok(timerAt !== -1 && timerAt < reduceAt && reduceAt < hideAt && hideAt < timingAt && timingAt < holdAt, 'after motion.hold, reduce motion hides the counter and otherwise it fades with motion.normal')
  t.ok(src.includes('const dots = dotWindow(page, count)'), 'dots ask for the window')
  t.ok(src.includes('items.slice(dots.start, dots.end)'), 'only the window is drawn')
  t.ok(src.includes('showArrows && (hovered || focused) && many && measured'), 'chevrons show on hover or focus')
  t.ok(src.includes("if (pointerTypeOf(event) !== 'touch') setHovered(true)"), 'a touch does not count as hover')
  t.ok(src.includes('onPointerLeave={() => setHovered(false)}'), 'leaving the shell hides the hover chevrons')
  t.is(src.split('onFocus=').length - 1, 1, 'one focus handler')
  t.ok(src.includes('onFocus={(event) => setFocused(keyboardFocus(event))}'), 'focus updates from the keyboard check')
  t.ok(src.includes('const target = event && event.target'), 'the check reads the focused node')
  t.ok(src.includes("typeof target.matches !== 'function'"), 'no matches means not keyboard')
  t.ok(src.includes("return target.matches(':focus-visible') === true"), 'only :focus-visible counts')
  t.absent(src.includes('setFocused(true)'), 'a tap, a click or a pointer close cannot force the chevrons on')
  t.ok(src.includes('button.focus({ preventScroll: true })'), 'closing the viewer still focuses the visible photo, judged by the same check')
  t.ok(src.includes('if (next !== page && (next === 0 || next === count - 1)) {'), 'reaching either end is handled')
  t.ok(src.includes("if (focused) refocus.current = next === 0 ? 'next' : 'prev'"), 'a keyboard user at either end keeps focus on the other chevron')
  t.ok(src.includes('else setFocused(false)'), 'without keyboard focus the unmounted chevron clears focus')
  t.ok(src.includes('ref={prevArrow}') && src.includes('ref={nextArrow}'), 'both chevrons can take focus')
  t.ok(/useEffect\(\(\) => \{\n {4}const side = refocus\.current[\s\S]*?node\.focus\(\{ preventScroll: true \}\)[\s\S]*?\}, \[page\]\)/.test(src), 'focus moves after the page change commits, without scrolling')
  t.absent(src.includes('tabIndex={0}'), 'the shell is not a tab stop')
  t.absent(src.includes('Platform.OS'), 'capability, never the platform')
  t.is(src.split('slideLabel(').length - 1, 2, 'each photo still announces its position')
})

test('MediaCarousel keeps the photo overlay colors', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/MediaCarousel.js'), 'utf8')
  t.ok(/counter: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.55\)'/.test(src), 'counter scrim')
  t.ok(/counterText: \{ color: '#ffffff'/.test(src), 'counter text')
  t.ok(/arrow: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.45\)'/.test(src), 'arrow scrim')
  t.ok(/dotOnDark: \{ backgroundColor: '#ffffff' \}/.test(src), 'dark active dot')
  t.ok(/dotOffDark: \{ backgroundColor: 'rgba\(255,255,255,0\.4\)' \}/.test(src), 'dark idle dot')
  t.is(src.split("color='#ffffff'").length - 1, 2, 'both chevron icons')
  t.absent(src.includes('colors.dim'), 'the overlay is not the theme dim')
  t.absent(src.includes('stripes'), 'the overlay is not a stripe ink')
})
