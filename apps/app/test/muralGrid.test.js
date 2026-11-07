'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8')
const grid = read('MuralGrid.js')
const segmented = read('Segmented.js')

test('MuralGrid is a virtualised list of media tiles that forwards persist', (t) => {
  t.ok(/import \{[^}]*FlatList[^}]*\} from 'react-native'/.test(grid), 'FlatList')
  t.ok(/import \{ MediaView \} from '\.\/MediaView'/.test(grid), 'MediaView')
  t.ok(grid.includes('persist={persist}'), 'forwards persist')
  t.ok(grid.includes('tile.media[0]'), 'first photo only')
  t.absent(grid.includes('coracao'), 'no like counts')
})

test('MuralGrid footer states are explicit', (t) => {
  for (const text of ['Ver mais', 'Fim do Mural', 'Nenhuma foto ainda', 'Algumas fotos podem faltar']) t.ok(grid.includes(text), text)
  t.ok(grid.includes("name='copiar'"), 'multi photo badge')
  t.ok(grid.includes("<EmptyState icon='imagem' title='Nenhuma foto ainda'"), 'empty state with an icon')
  const at = grid.indexOf("if (state === 'end' && count === 0)")
  const empty = grid.slice(at, grid.indexOf('\n  }\n', at))
  t.ok(empty.includes('Algumas fotos podem faltar'), 'an empty but incomplete Mural still says photos may be missing')
  t.absent(grid.includes('onEndReached'), 'never loads on scroll')
})

test('host lists get the row gaps and an empty last row stays empty', (t) => {
  // The profile screens render MuralRow inside their own list, which has no
  // separator: the row carries the 2 pt gap itself.
  t.ok(grid.includes("row: { flexDirection: 'row', gap: 2, marginBottom: 2 }"), 'row gap below')
  t.absent(grid.includes('ItemSeparatorComponent'), 'no separator doubling the gap')
  t.ok(grid.includes('pad: { flex: 1, aspectRatio: 1 },'), 'pad cells have no background')
  t.ok(grid.includes('style={styles.pad}'), 'pad cells use it')
})

test('Segmented is a tab list', (t) => {
  t.ok(segmented.includes("accessibilityRole='tab'"), 'tab role')
  t.ok(segmented.includes('accessibilityState={{ selected: on }}'), 'selected state')
  t.ok(segmented.includes('aria-selected={on}'), 'selected state on the web')
})

test('a tile opens its post even when the cover failed', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'MuralGrid.js'), 'utf8')
  t.ok(src.includes('onPress={() => onOpen && onOpen(tile)}') && src.includes("pointerEvents='none'"), 'the tile Pressable owns the tap')
  const media = src.slice(src.indexOf('<MediaView'), src.indexOf('/>', src.indexOf('<MediaView')))
  t.absent(media.includes('onPress'), 'MediaView gets no onPress, so a failed cover cannot become a retry-only button')
  // pointerEvents does not stop keyboard focus on the web: the retry button
  // itself must not exist inside a tile.
  t.ok(media.includes('tapRetry={false}'), 'no nested retry button')
  const view = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'MediaView.js'), 'utf8')
  t.ok(view.includes('const press = failed ? (tapRetry ? retry : undefined) : onPress'), 'MediaView honours tapRetry')
})

test('a tile is announced once', (t) => {
  t.ok(grid.includes("importantForAccessibility='no-hide-descendants'") && grid.includes('accessibilityElementsHidden') && grid.includes('aria-hidden'), 'inner image hidden from screen readers')
})
