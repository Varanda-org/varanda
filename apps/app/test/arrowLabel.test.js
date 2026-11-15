'use strict'

// The carousel arrows name the photo they lead to. The wiring check reads
// MediaCarousel.js from disk.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/arrowLabel.js')

test('arrowLabel names the target position', async (t) => {
  const { arrowLabel } = await load()
  t.is(arrowLabel(2, 5, -1), 'Foto anterior, 2 de 5')
  t.is(arrowLabel(3, 5, 1), 'Próxima foto, 5 de 5')
  t.is(arrowLabel(1, 5, 1), 'Próxima foto, 3 de 5')
  t.is(arrowLabel(1, 2, -1), 'Foto anterior, 1 de 2')
})

test('arrowLabel is empty where there is no photo to go to', async (t) => {
  const { arrowLabel } = await load()
  t.is(arrowLabel(0, 5, -1), '', 'no previous on the first photo')
  t.is(arrowLabel(4, 5, 1), '', 'no next on the last photo')
  t.is(arrowLabel(0, 1, 1), '', 'a single photo')
  t.is(arrowLabel(NaN, 5, 1), '')
  t.is(arrowLabel(5, 5, -1), '', 'a page past the end')
  t.is(arrowLabel(-1, 5, 1), '')
})

test('MediaCarousel labels both arrows through arrowLabel', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/MediaCarousel.js'), 'utf8')
  t.ok(src.includes("import { arrowLabel } from '../arrowLabel'"), 'imports the helper')
  t.ok(src.includes('accessibilityLabel={arrowLabel(page, count, -1)}'), 'previous arrow')
  t.ok(src.includes('accessibilityLabel={arrowLabel(page, count, 1)}'), 'next arrow')
  t.absent(src.includes("accessibilityLabel='foto anterior'") || src.includes("accessibilityLabel='próxima foto'"), 'no bare label left')
})
