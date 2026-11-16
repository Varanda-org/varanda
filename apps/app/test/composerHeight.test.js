'use strict'

const test = require('brittle')
const load = () => import('../src/composerHeight.js')
const opts = { line: 22, pad: 9, maxLines: 6 }

test('heightFloor: one line per line break, capped at maxLines', async (t) => {
  const { heightFloor } = await load()
  t.is(heightFloor('', opts), 40, 'empty: one line')
  t.is(heightFloor('banana', opts), 40)
  t.is(heightFloor('```\nbanana\n```', opts), 22 * 3 + 18, 'a code block shows its fences')
  t.is(heightFloor('a\nb\nc\nd\ne\nf\ng\nh', opts), 22 * 6 + 18, 'never past maxLines')
  t.is(heightFloor(null, opts), 40, 'no text: one line')
})
