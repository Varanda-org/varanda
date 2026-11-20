'use strict'
const test = require('brittle')

test('segmentedFit tightens only when a tab is narrow', async (t) => {
  const { segmentedFit, TIGHT_TAB_WIDTH } = await import('../src/ui/segmentedFit.js')
  t.is(TIGHT_TAB_WIDTH, 124, 'the regular label and padding need 124 pt per tab')
  t.is(segmentedFit(372, 3).tight, false, 'at 124 pt per tab, regular')
  t.is(segmentedFit(371, 3).tight, true, 'below 124 pt per tab, tight')
  t.is(segmentedFit(360, 3).tight, true, '360 pt, three tabs, tight: "Depoimentos" would leave no margin')
  t.is(segmentedFit(390, 3).tight, false, '390 pt, three tabs, unchanged')
  t.is(segmentedFit(320, 2).tight, false, '320 pt, two tabs, unchanged')
  t.alike(segmentedFit(320, 3), { tight: true, paddingHorizontal: 2, fontSize: 13 }, '320 pt, three tabs, tight')
  t.is(segmentedFit(320, 4).tight, true, '320 pt, four tabs, tight')
  t.is(segmentedFit(0, 3).tight, false, 'unmeasured stays as before')
  t.is(segmentedFit(NaN, 3).tight, false, 'bad width stays as before')
  t.is(segmentedFit(320, 4, true).tight, false, 'text that shrinks to fit stays as before')
  t.is(segmentedFit(320, 4, false).tight, true, 'text that does not shrink tightens')
})

test('segmentedFit tightens two tabs whose longest label does not fit', async (t) => {
  const { segmentedFit } = await import('../src/ui/segmentedFit.js')
  t.is(segmentedFit(320, 2, false, 18).tight, true, '"Republicações · 12" at 320 pt tightens')
  t.is(segmentedFit(390, 2, false, 18).tight, false, '"Republicações · 12" at 390 pt stays regular')
  t.is(segmentedFit(390, 2, false, 23).tight, true, '"Republicações · 1,2 mil" at 390 pt tightens')
  t.is(segmentedFit(320, 2, false, 11).tight, false, 'a short label keeps the floor')
  t.is(segmentedFit(320, 2, true, 23).tight, false, 'text that shrinks to fit stays as before')
})

test('Segmented tightens only where the text does not shrink', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/ui/Segmented.js'), 'utf8')
  t.ok(src.includes("const SHRINKS = Platform.OS !== 'web'") && src.includes('segmentedFit(width, list.length, SHRINKS, longest)'), 'phones keep adjustsFontSizeToFit')
  t.ok(src.includes("Math.max(n, typeof option.label === 'string' ? option.label.length : 0)"), 'the fit reads the longest drawn label')
})
