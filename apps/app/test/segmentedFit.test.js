'use strict'
const test = require('brittle')

test('segmentedFit tightens only when a tab is narrow', async (t) => {
  const { segmentedFit, TIGHT_FONT_SIZE, TIGHT_PADDING } = await import('../src/ui/segmentedFit.js')
  t.is(segmentedFit(390, 3).tight, false, '390 pt, three tabs, unchanged')
  t.is(segmentedFit(320, 2).tight, false, '320 pt, two tabs, unchanged')
  t.alike(segmentedFit(320, 3), { tight: true, paddingHorizontal: TIGHT_PADDING, fontSize: TIGHT_FONT_SIZE }, '320 pt, three tabs, tight')
  t.is(segmentedFit(320, 4).tight, true, '320 pt, four tabs, tight')
  t.is(segmentedFit(0, 3).tight, false, 'unmeasured stays as before')
  t.is(segmentedFit(NaN, 3).tight, false, 'bad width stays as before')
  t.is(segmentedFit(320, 4, true).tight, false, 'text that shrinks to fit stays as before')
  t.is(segmentedFit(320, 4, false).tight, true, 'text that does not shrink tightens')
})

test('Segmented tightens only where the text does not shrink', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/ui/Segmented.js'), 'utf8')
  t.ok(src.includes("const SHRINKS = Platform.OS !== 'web'") && src.includes('segmentedFit(width, list.length, SHRINKS)'), 'phones keep adjustsFontSizeToFit')
})
