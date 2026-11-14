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

test('the listing card is gone, ListingTile carries the retry rule', (t) => {
  t.absent(require('fs').existsSync(require('path').join(__dirname, '..', 'src', 'ui', 'ListingCard.js')), 'ListingCard.js is deleted')
  const tile = read('ListingTile.js')
  const media = tile.slice(tile.indexOf('<MediaView'), tile.indexOf('/>', tile.indexOf('<MediaView')))
  t.ok(media.includes('tapRetry={false}'), 'no nested retry button')
  t.absent(media.includes('onPress'), 'MediaView gets no onPress')
})

test('a tile is announced once', (t) => {
  t.ok(grid.includes("importantForAccessibility='no-hide-descendants'") && grid.includes('accessibilityElementsHidden') && grid.includes('aria-hidden'), 'inner image hidden from screen readers')
})

test('Segmented labels shrink to fit instead of being cut', (t) => {
  t.ok(segmented.includes('adjustsFontSizeToFit minimumFontScale={0.7}'), 'three tabs at large text keep whole labels')
})

test('tileLabel: a pair is vídeo, photos keep foto and the count', async (t) => {
  const { tileLabel } = await import('../src/ui/muralLabel.js')
  const photo = { mime: 'image/jpeg' }
  const video = { mime: 'video/mp4' }
  t.is(tileLabel({ media: [photo, video] }), 'vídeo', 'a pair is one video, not 2 fotos')
  t.is(tileLabel({ media: [photo] }), 'foto')
  t.is(tileLabel({ media: [photo, photo, photo] }), '3 fotos')
  t.is(tileLabel({ media: [photo, photo] }), '2 fotos', 'two photos are still photos')
  t.is(tileLabel({ media: [video, photo] }), '2 fotos', 'only a poster then a clip is a pair')
  const now = Date.parse('2026-11-12T12:00:00Z')
  t.is(tileLabel({ media: [photo, video], at: new Date(now - 5 * 60000).toISOString() }, now), 'vídeo, 5 min', 'the time follows')
  t.is(tileLabel({}), 'foto', 'no media still reads foto')
  t.ok(/import \{ tileLabel \} from '\.\/muralLabel'/.test(grid) && grid.includes('export { tileLabel }'), 'MuralGrid uses and exports it')
  t.ok(grid.includes('accessibilityLabel={tileLabel(tile)}'), 'the tile is announced with it')
})

test('a video pair shows a play mark and duration, not a photo count', (t) => {
  t.ok(grid.includes("name='tocar'"), 'play mark')
  t.ok(grid.includes('durationLabel(pair.video.ms)'), 'duration on the tile')
  t.ok(grid.includes("name='copiar'"), 'several photos keep the badge')
  t.ok(grid.indexOf("name='tocar'") < grid.indexOf("name='copiar'"), 'the play mark is the video branch')
  t.ok(grid.includes('tile.media[0]'), 'the tile still shows the poster')
  t.ok(grid.includes('onPress={() => onOpen && onOpen(tile)}'), 'a tap still opens the post')
})

test('Segmented: three tabs share one text size, two keep theirs', (t) => {
  t.ok(segmented.includes('export const SEGMENTED_CAP_TWO = 1.5'), 'two tabs keep the 1.5 cap')
  t.ok(segmented.includes('export const SEGMENTED_CAP_MANY = 1.2'), 'three or more cap at 1.2')
  t.ok(segmented.includes('return count >= 3 ? SEGMENTED_CAP_MANY : SEGMENTED_CAP_TWO'), 'cap picked by the option count')
  t.ok(segmented.includes('const cap = segmentedCap(list.length)') && segmented.includes('maxFontSizeMultiplier={cap}'), 'every label gets the same cap')
  t.absent(segmented.includes('maxFontSizeMultiplier={1.5}'), 'no fixed 1.5 cap left')
  t.ok(/label: \{[^}]*textAlign: 'center'[^}]*textAlignVertical: 'center'[^}]*includeFontPadding: false/.test(segmented), 'a shrunk label stays centred')
})
