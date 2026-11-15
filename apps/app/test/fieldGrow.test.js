'use strict'

// The growing composer fields on the web: the pure height rule, the textarea
// measurement (src/ui/fieldMeasure.web.js) and where the composers use it.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('growHeight keeps the content height between the minimum and the maximum', async (t) => {
  const { growHeight } = await import('../src/ui/fieldHeight.js')
  t.is(growHeight(10, 40, 150), 40, 'short content: the minimum')
  t.is(growHeight(90.2, 40, 150), 91, 'rounded up')
  t.is(growHeight(400, 40, 150), 150, 'long content: the maximum')
  t.is(growHeight(400, 120, Infinity), 400, 'no maximum')
  for (const bad of [undefined, null, NaN, Infinity, '90']) t.is(growHeight(bad, 40, 150), 40, String(bad))
})

// A textarea as the browser has it: with no rows, height auto is two rows
// (62 px here) at the least; at 0 it is the content; set, it is the box. The
// scrolling parent clamps its scroll while the box is short.
function fakeTextarea (content, boxHeight, parentScroll = 0) {
  const parent = { scrollTop: parentScroll, parentElement: null }
  let height = boxHeight + 'px'
  const el = {
    content,
    parentElement: parent,
    style: {
      get height () { return height },
      set height (value) {
        height = value
        if (value === '0px') parent.scrollTop = 0
      }
    },
    get scrollHeight () {
      if (height === 'auto') return Math.max(el.content, 62)
      if (height === '0px') return el.content
      return Math.max(el.content, parseInt(height, 10))
    }
  }
  return { el, parent }
}

test('web measurement reads the content with height 0 (never the two-row default), so a field also shrinks, and puts the height back', async (t) => {
  const { measureField } = await import('../src/ui/fieldMeasure.web.js')
  const { el } = fakeTextarea(130, 150)
  t.is(measureField(el, 40, 150), 130, 'the content height, not the old box')
  t.is(el.style.height, '150px', 'the style is restored')
  el.content = 60
  t.is(measureField(el, 40, 150), 60, 'deleted text shrinks the field')
  el.content = 10
  t.is(measureField(el, 40, 150), 40, 'down to the minimum')
  const empty = fakeTextarea(18, 40).el
  t.is(measureField(empty, 40, 150), 40, 'an empty one-line field stays one line, not two')
  t.is(measureField(empty, 18, 150), 18, 'even where the minimum is below the two-row default')
  el.content = 100
  t.is(measureField(el, 40, 150, 2), 102, 'a border is added')
  t.is(measureField(el, 40, 120, 40), 120, 'and the maximum still holds')
  t.is(measureField(null, 40, 150), null)
  t.is(measureField({}, 40, 150), null, 'not a textarea')
})

test('web measurement leaves the scroll of the sheet where it was and restores the height when the read throws', async (t) => {
  const { measureField } = await import('../src/ui/fieldMeasure.web.js')
  const { el, parent } = fakeTextarea(130, 150, 240)
  measureField(el, 40, 150)
  t.is(parent.scrollTop, 240, 'the shrink did not move the scroll')
  const throwing = { style: { height: '9px' }, parentElement: null, get scrollHeight () { throw new Error('x') } }
  t.exception(() => measureField(throwing, 40, 150))
  t.is(throwing.style.height, '9px', 'restored even when the read throws')
})

test('native has no measurement: the platform grows the field', async (t) => {
  const { measureField } = await import('../src/ui/fieldMeasure.native.js')
  t.is(measureField({ style: {}, scrollHeight: 99 }, 40, 150), null)
})

test('the composers measure the field after every text change on the web, before the paint', (t) => {
  const chat = read('ui/ChatComposer.js')
  t.ok(chat.includes("import { measureField } from './fieldMeasure'"))
  t.ok(chat.includes('useLayoutEffect(() => {\n    if (text === \'\') setHeight(MIN_HEIGHT)\n    const measured = measureField(inputRef.current, MIN_HEIGHT, MAX_HEIGHT)') && chat.includes('}, [text])'), 'chat field between one and six lines, before the paint')
  t.ok(chat.includes('onContentSizeChange={(event) => {'), 'native keeps its content-size handler')
  const post = read('screens/Publicar.js')
  t.ok(post.includes("import { measureField } from '../ui/fieldMeasure'"))
  t.ok(post.includes('useLayoutEffect(() => {\n    if (!GROW_BY_CONTENT || momentMode || !open) return\n    const measured = measureField(inputRef.current, POST_MIN_HEIGHT, Infinity)') && post.includes('}, [text, momentMode, open])'), 'post field, before the paint')
  t.ok(post.includes('style={[styles.input, GROW_BY_CONTENT && postHeight !== null && { height: postHeight }]}'), 'the measured height reaches the field')
  t.ok(post.includes('measureField(momentView.fieldRef.current, MOMENT_MIN_HEIGHT, MOMENT_MAX_HEIGHT, 2)'), 'momento field')
  t.is(post.match(/\bPOST_MIN_HEIGHT\b/g).length, 3, 'one minimum for the style and the measurement')
})
