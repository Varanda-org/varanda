'use strict'

// Caption clamp (src/postClamp.js). Pure ES module: import() loads it here
// through Node's module syntax detection. At width 5 and fontSize 10 the
// estimate is one line per code point, so the limits are readable as counts.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/postClamp.js')
const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')

const FIT = { width: 5, fontSize: 10 }

function plan (clampPlan, text, extra) {
  return clampPlan({ text, ...FIT, ...extra })
}

test('short text never clamps', async (t) => {
  const { clampPlan } = await load()
  t.alike(plan(clampPlan, ''), { lines: 0, control: null })
  t.alike(plan(clampPlan, 'oi'), { lines: 0, control: null })
  t.alike(plan(clampPlan, 'a'.repeat(10)), { lines: 0, control: null }, 'one over the text limit stays')
  t.alike(plan(clampPlan, 'a'.repeat(4), { hasMedia: true }), { lines: 0, control: null }, 'one over the media limit stays')
  t.alike(clampPlan(), { lines: 0, control: null })
})

test('media clamps at 3 and text at 9', async (t) => {
  const { clampPlan, LIMIT_MEDIA, LIMIT_TEXT } = await load()
  t.is(LIMIT_MEDIA, 3)
  t.is(LIMIT_TEXT, 9)
  t.alike(plan(clampPlan, 'a'.repeat(5), { hasMedia: true }), { lines: LIMIT_MEDIA, control: 'mais' })
  t.alike(plan(clampPlan, 'a'.repeat(5)), { lines: 0, control: null }, 'the same caption without media stays open')
  t.alike(plan(clampPlan, 'a'.repeat(11)), { lines: LIMIT_TEXT, control: 'ver mais' })
  t.alike(plan(clampPlan, 'a'.repeat(11), { hasMedia: true }), { lines: LIMIT_MEDIA, control: 'mais' })
})

test('the estimate must exceed the limit by 2 or more', async (t) => {
  const { clampPlan } = await load()
  t.alike(plan(clampPlan, 'a'.repeat(10)), { lines: 0, control: null }, 'text limit + 1')
  t.alike(plan(clampPlan, 'a'.repeat(11)), { lines: 9, control: 'ver mais' }, 'text limit + 2')
  t.alike(plan(clampPlan, 'a'.repeat(4), { hasMedia: true }), { lines: 0, control: null }, 'media limit + 1')
  t.alike(plan(clampPlan, 'a'.repeat(5), { hasMedia: true }), { lines: 3, control: 'mais' }, 'media limit + 2')
})

test('expanded shows menos only when the caption would have clamped', async (t) => {
  const { clampPlan } = await load()
  t.alike(plan(clampPlan, 'a'.repeat(11), { expanded: true }), { lines: 0, control: 'menos' })
  t.alike(plan(clampPlan, 'a'.repeat(11), { hasMedia: true, expanded: true }), { lines: 0, control: 'menos' })
  t.alike(plan(clampPlan, 'oi', { expanded: true }), { lines: 0, control: null })
  t.alike(plan(clampPlan, 'a'.repeat(4), { hasMedia: true, expanded: true }), { lines: 0, control: null })
})

test('paragraphs are summed and a blank line counts', async (t) => {
  const { clampPlan } = await load()
  t.alike(plan(clampPlan, 'aaaa', { hasMedia: true }), { lines: 0, control: null })
  t.alike(plan(clampPlan, 'bb', { hasMedia: true }), { lines: 0, control: null })
  t.alike(plan(clampPlan, 'aaaa\nbb', { hasMedia: true }), { lines: 3, control: 'mais' }, '4 + 2 crosses the media margin')
  t.alike(plan(clampPlan, '\n\n\n\n', { hasMedia: true }), { lines: 3, control: 'mais' }, 'five blank lines')
  t.alike(plan(clampPlan, 'aaa b', { hasMedia: true }), { lines: 3, control: 'mais' }, 'a space is not a paragraph break')
})

test('width and font size change the estimate', async (t) => {
  const { clampPlan } = await load()
  // Half a glyph per point: 20 code points are 10 lines, 22 are 11.
  t.alike(clampPlan({ text: 'a'.repeat(20), width: 10, fontSize: 10 }), { lines: 0, control: null })
  t.alike(clampPlan({ text: 'a'.repeat(22), width: 10, fontSize: 10 }), { lines: 9, control: 'ver mais' })
  t.alike(clampPlan({ text: 'a'.repeat(10), width: 5, fontSize: 10 }), { lines: 0, control: null })
  t.alike(clampPlan({ text: 'a'.repeat(10), width: 5, fontSize: 20 }), { lines: 9, control: 'ver mais' }, 'double the font size')
})

test('a width or font size that is not laid out does not clamp', async (t) => {
  const { clampPlan } = await load()
  const text = 'a'.repeat(40)
  for (const width of [0, -5, NaN, Infinity]) {
    t.alike(clampPlan({ text, width, fontSize: 10 }), { lines: 0, control: null })
  }
  for (const fontSize of [0, -1, NaN, Infinity]) {
    t.alike(clampPlan({ text, width: 5, fontSize }), { lines: 0, control: null })
  }
  t.alike(clampPlan({ text: null, width: 5, fontSize: 10 }), { lines: 0, control: null })
  t.alike(clampPlan({ text: 'oi', ...FIT, fontScale: NaN }), { lines: 0, control: null }, 'a missing scale is 1, not a clamp')
})

test('refine lifts a clamp the measurement does not need and never adds one', async (t) => {
  const { refine } = await load()
  const clamped = { lines: 9, control: 'ver mais' }
  const hidden = refine(clamped, 9)
  t.alike(hidden, { lines: 0, control: null }, 'a caption that fits is uncapped, so its links and mentions work')
  t.is(clamped.control, 'ver mais', 'does not mutate the plan')
  t.alike(refine(clamped, 8), { lines: 0, control: null })
  t.alike(refine({ lines: 3, control: 'mais' }, 3), { lines: 0, control: null })
  const over = refine(clamped, 10)
  t.is(over, clamped, 'a longer measurement keeps the control')
  t.is(refine(clamped, undefined), clamped)
  t.is(refine(clamped), clamped)
  t.is(refine(clamped, null), clamped)
  t.is(refine(clamped, '9'), clamped)
  t.is(refine(clamped, NaN), clamped, 'NaN is not a fit')
  t.is(refine(clamped, Infinity), clamped)
  t.is(refine(clamped, 0), clamped, 'zero lines is not a fit')
  t.is(refine(clamped, -1), clamped)
  const open = { lines: 0, control: null }
  t.is(refine(open, 40), open, 'never adds a clamp')
  const menos = { lines: 0, control: 'menos' }
  t.is(refine(menos, 12), menos, 'a full measurement keeps menos')
})

test('fontScale above 1.3 is capped and a scale under the cap still counts', async (t) => {
  const { clampPlan } = await load()
  const three = { text: 'abc', hasMedia: true, ...FIT }
  const atCap = clampPlan({ ...three, fontScale: 1.3 })
  t.alike(atCap, { lines: 0, control: null })
  // Uncapped, 1.4 is ceil(3 * 1.4) = 5 lines and would clamp. Capped, it matches 1.3.
  for (const fontScale of [1.31, 1.4, 2, 8]) {
    t.alike(clampPlan({ ...three, fontScale }), atCap, 'scale ' + fontScale)
  }
  t.alike(plan(clampPlan, 'abcd', { hasMedia: true, fontScale: 1 }), { lines: 0, control: null })
  t.alike(plan(clampPlan, 'abcd', { hasMedia: true, fontScale: 1.3 }), { lines: 3, control: 'mais' }, '1.3 is applied, not dropped')
  t.alike(
    clampPlan({ text: 'abcd', hasMedia: true, ...FIT }),
    clampPlan({ text: 'abcd', hasMedia: true, ...FIT, fontScale: 1 }),
    'the default scale is 1'
  )
})

test('emoji and accented text are counted by code point', async (t) => {
  const { clampPlan } = await load()
  // U+1F600 is one code point and two UTF-16 units. Four stay under the
  // media margin; counting units would see eight lines and clamp.
  const grin = '\u{1F600}'
  t.is(Array.from(grin).length, 1)
  t.is(grin.length, 2)
  t.alike(plan(clampPlan, grin.repeat(4), { hasMedia: true }), { lines: 0, control: null })
  t.alike(plan(clampPlan, grin.repeat(5), { hasMedia: true }), { lines: 3, control: 'mais' })
  // U+00E1 is one code point, not two bytes. Ten stay open; eleven clamp.
  const acute = '\u00e1'
  t.alike(plan(clampPlan, acute.repeat(10)), { lines: 0, control: null })
  t.alike(plan(clampPlan, acute.repeat(11)), { lines: 9, control: 'ver mais' })
  // ç + ã + o is 3 code points. Ten stay open; a byte count of the accents
  // would clamp. Twelve clamp; counting the whole word as 2 would stay open.
  const cao = '\u00e7\u00e3o'
  t.alike(plan(clampPlan, cao.repeat(3) + 'a'), { lines: 0, control: null })
  t.alike(plan(clampPlan, cao.repeat(4)), { lines: 9, control: 'ver mais' })
  // a + combining acute is two code points and one grapheme. Six of them
  // are 12 lines and clamp; a grapheme count of 6 would not.
  t.alike(plan(clampPlan, 'a\u0301'.repeat(6)), { lines: 9, control: 'ver mais' })
})

test('the scale cap stays equal to TEXT_CAP', (t) => {
  const sheet = read('ui/Sheet.js')
  const src = read('postClamp.js')
  const found = sheet.match(/export const TEXT_CAP = ([0-9.]+)/)
  t.ok(found, 'TEXT_CAP is exported')
  t.ok(src.includes('const SCALE_CAP = ' + found[1]), 'postClamp caps the scale at TEXT_CAP')
  t.absent(src.includes('\u2014'), 'postClamp has no em dash')
  t.absent(src.includes('import '), 'the pure module has no imports')
  t.absent(src.includes('Platform'), 'the pure module does not branch on platform')
})

test('measurements ignore the rendered cap and preserve a larger full count', async (t) => {
  const { acceptMeasurement } = await load()
  t.is(typeof acceptMeasurement, 'function')
  if (typeof acceptMeasurement !== 'function') return
  t.is(acceptMeasurement({ prev: undefined, count: 3, renderedCap: 3 }), undefined, 'a capped count is not proof of fit')
  t.is(acceptMeasurement({ prev: 2, count: 3, renderedCap: 3 }), 2, 'the cap does not replace an earlier count')
  t.is(acceptMeasurement({ prev: 12, count: 2, renderedCap: 3 }), 12, 'a later shorter layout preserves the full count')
  t.is(acceptMeasurement({ prev: undefined, count: 2, renderedCap: 3 }), 2, 'the first count below the cap is accepted')
  t.is(acceptMeasurement({ prev: undefined, count: 12, renderedCap: 3 }), 12, 'a full count above the cap is accepted')
  t.is(acceptMeasurement({ prev: undefined, count: 0, renderedCap: 0 }), undefined, 'zero lines is not a measurement when uncapped')
  t.is(acceptMeasurement({ prev: undefined, count: 0, renderedCap: 3 }), undefined, 'zero lines is not a measurement when capped')
  t.is(acceptMeasurement({ prev: 12, count: 0, renderedCap: 0 }), 12, 'zero lines keeps an earlier count')
  t.is(acceptMeasurement({ prev: undefined, count: 3, renderedCap: 0 }), 3, 'an uncapped count is accepted')
  t.is(acceptMeasurement({ prev: 3, count: 12, renderedCap: 0 }), 12, 'a longer uncapped count updates the measurement')
  t.is(acceptMeasurement({ prev: 12, count: 3, renderedCap: 0 }), 12, 'a shorter count never discards a full measurement')
})

test('ClampText defaults to the body column until a positive finite width is measured', (t) => {
  const src = read('ui/ClampText.js')
  t.ok(src.includes('const ROW_PADDING = space.lg * 2'))
  t.ok(src.includes('const AVATAR_SIZE = 40'))
  t.ok(src.includes('const AVATAR_GAP = 12'))
  t.ok(src.includes('const defaultWidth = Math.min(windowWidth, layout.column) - ROW_PADDING - AVATAR_SIZE - AVATAR_GAP'))
  t.ok(src.includes('const textWidth = Number.isFinite(width) && width > 0 ? width : defaultWidth'), 'undefined, zero, negative and non-finite widths use the default')
  t.ok(src.includes('width: textWidth,'), 'the estimate receives the effective width')
  t.ok(/body.*measured width.*onLayout/.test(src), 'caller guidance names the body onLayout measurement')
})

test('ClampText hides the control when expansion is forced', (t) => {
  const src = read('ui/ClampText.js')
  t.ok(src.includes('const open = forceExpanded === true || (!textChanged && expanded)'))
  t.ok(src.includes('expanded: open'), 'the plan and returned state are expanded')
  t.ok(src.includes('control: forceExpanded === true ? null : view.control'), 'forced expansion has no ineffective collapse button')
  t.ok(src.includes('numberOfLines: view.lines'), 'the expanded plan supplies the uncapped line count')
})

test('ClampText invalidates measurements on text, effective width or font scale changes', (t) => {
  const src = read('ui/ClampText.js')
  t.ok(src.includes('const [prevWidth, setPrevWidth] = useState(textWidth)'))
  t.ok(src.includes('const [prevFontScale, setPrevFontScale] = useState(fontScale)'))
  t.ok(src.includes('const measurementChanged = textChanged || Math.abs(textWidth - prevWidth) >= 0.5 || fontScale !== prevFontScale'), 'sub-point layout jitter keeps the measurement')
  t.ok(src.includes(`if (measurementChanged) {
    generation.current += 1
    setPrevWidth(textWidth)
    setPrevFontScale(fontScale)
    setMeasuredLines(undefined)
  }`), 'layout changes clear the measurement and invalidate old callbacks')
  t.ok(src.includes(`if (textChanged) {
    setPrevText(text)
    setExpanded(false)
  }`), 'only text changes reset expansion')
  t.is(src.split('setExpanded(false)').length - 1, 1, 'layout changes preserve expansion')
  t.ok(src.includes('const measured = measurementChanged ? undefined : measuredLines'), 'stale measurements cannot hide the control during the reset render')
  t.ok(src.includes('if (generation.current !== layoutGeneration) return'), 'old events are discarded')
  t.ok(src.includes('setMeasuredLines((prev) => acceptMeasurement({ prev, count, renderedCap }))'), 'the hook delegates measurement acceptance to the tested function')
  t.ok(src.includes('}, [layoutGeneration, renderedCap])'), 'the callback captures the current layout and cap')
})

test('ClampControl names include visible words and expose expansion without a tall row', (t) => {
  const src = read('ui/ClampText.js')
  t.ok(src.includes("mais: 'mais, ver texto completo'"))
  t.ok(src.includes("'ver mais': 'ver mais, texto completo'"))
  t.ok(src.includes("menos: 'menos, recolher texto'"))
  t.ok(src.includes('accessibilityLabel={CONTROL_LABELS[control]}'))
  t.ok(src.includes("accessibilityState={{ expanded: control === 'menos' }}"))
  t.ok(src.includes('const verticalHitSlop = Math.max(0, (layout.hit - type.more.lineHeight) / 2)'))
  t.absent(src.includes('hitSlop={'), 'the web ignores hitSlop')
  t.ok(src.includes('paddingVertical: verticalHitSlop') && src.includes('marginBottom: -verticalHitSlop'), 'padding reaches 44 pt on every platform')
  t.absent(/margin(Top|Vertical): -/.test(src), 'the target never covers the caption above it')
  t.ok(src.includes("aria-expanded={control === 'menos'}"), 'the web exposes the expanded state')
  t.ok(src.includes('minWidth: layout.hit'))
  t.absent(src.includes('minHeight'), 'the control does not add a 44 pt row')
})

test('ClampText wires the estimate, the hit target and the labels', (t) => {
  const src = read('ui/ClampText.js')
  t.ok(src.includes("from '../postClamp.js'"))
  t.ok(src.includes('clampPlan'))
  t.ok(src.includes('refine'))
  t.ok(src.includes('type.postText.fontSize'), 'the estimate uses the post text size')
  t.ok(src.includes('useWindowDimensions'))
  t.ok(src.includes('space.lg * 2'), 'default width subtracts the row padding on both sides')
  t.ok(src.includes('onTextLayout'))
  t.ok(src.includes('layout.hit'), 'the control hit area is the 44 pt target')
  t.ok(src.includes('maxFontSizeMultiplier={TEXT_CAP}'))
  t.ok(src.includes("accessibilityRole='button'"))
  t.ok(src.includes('ver texto completo'))
  t.ok(src.includes('recolher texto'))
  t.ok(src.includes('>{control}<'), 'the visible words are the control')
  t.absent(src.includes('Platform'), 'layout capability, not the platform name')
  t.absent(src.includes('\u2014'), 'ClampText has no em dash')
  t.absent(/#[0-9a-fA-F]{3,8}/.test(src), 'no color literal')
})
