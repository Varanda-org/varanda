'use strict'

// How GardenSceneView draws enfeites. The component imports react-native,
// so this reads the source, the same way the other scene wiring tests do.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '../src/ui/GardenSceneView.js')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

test('GardenSceneView: enfeites stay in the reader-hidden layer', (t) => {
  const raw = fs.readFileSync(SRC, 'utf8')
  const src = withoutComments(raw)
  t.absent(raw.includes('\u2014'), 'no em dash')
  t.absent(raw.includes('\u2013'), 'no en dash')
  t.ok(/import \{[^}]*\bdecorDrawing\b[^}]*\} from '\.\/gardenDecor'/.test(src), 'imports decorDrawing from gardenDecor.js')
  t.ok(/import \{[^}]*\bdecorPalette\b[^}]*\} from '\.\/gardenDecor'/.test(src), 'imports decorPalette from gardenDecor.js')
  t.ok(/gardenLayout\(\s*width,\s*\{\s*decor\b/.test(src), 'calls gardenLayout with a decor option')
  t.is((src.match(/gardenLayout\(/g) || []).length, 1, 'the existing layout call')
  t.is((src.match(/\buseMemo\(/g) || []).length, 1, 'still the one memo')
  t.ok(/\[width, decorIds\]/.test(src), 'keyed on width and the joined known ids')
  const keyFn = src.slice(src.indexOf('function joinedDecor'), src.indexOf('function DecorArt'))
  t.ok(keyFn.includes(".join(',')"), 'known ids are joined')
  t.ok(keyFn.includes('DECOR_IDS.includes(id)'), 'an unknown id is not a known id')
  t.ok(keyFn.includes('getOwnPropertyDescriptor'), 'a getter is not called')
  t.is((src.match(/<Pressable\b/g) || []).length, 1, 'no Pressable beyond the pots')
  t.is((src.match(/Animated\./g) || []).length, 7, 'no Animated call beyond the sway and its glow')
  t.is((src.match(/new Animated\.Value\(/g) || []).length, 1, 'one animated value')
  t.ok(src.includes('opacity: glow'), 'the glow breathes on the sway clock')
  t.ok(/memo\(function Backdrop\b/.test(src), 'the backdrop is memoized')
  const back = src.indexOf('StyleSheet.absoluteFill')
  const layer = src.slice(src.lastIndexOf('<View', back), src.indexOf('<Pressable'))
  t.ok(layer.includes('hiddenFromReaders'), 'the background layer is hidden from readers')
  t.ok(layer.includes("pointerEvents='none'"), 'the background layer takes no touch')
  t.ok(/layout\.decor\s*\?/.test(layer), 'no decor key draws nothing')
  t.ok(layer.includes('<DecorArt'), 'decor is drawn in that layer')
  t.ok(layer.indexOf('backdropShapes(') >= 0 && layer.indexOf('backdropShapes(') < layer.indexOf('<DecorArt'), 'after the sky, city and floor')
  t.ok(layer.indexOf('<DecorArt') < layer.indexOf('railShapes('), 'before the railing')
  t.is((src.match(/<DecorArt\b/g) || []).length, 1, 'drawn in one place')
  const pots = src.slice(src.indexOf('<Pressable'))
  t.absent(pots.includes('<DecorArt'), 'pots are not enfeites')
  t.absent(pots.includes('decorDrawing'), 'pots do not draw enfeites')
  t.ok(/decorPalette\(scheme\)/.test(src), 'colours follow the scheme')
  const art = src.slice(src.indexOf('function DecorArt'), src.indexOf('export function GardenSceneView'))
  t.ok(art.includes('decorDrawing(id)'), 'the drawing comes from gardenDecor')
  t.ok(art.includes('<ShapeList'), 'reuses the pot and plant shape renderer')
  t.ok(/Math\.min\(rect\.w \/ w, rect\.h \/ h\)/.test(art), 'uniform scale')
  t.ok(art.includes('rect.x + (rect.w - w * scale) / 2'), 'centred horizontally')
  t.ok(art.includes('rect.y + rect.h - h * scale'), 'aligned to the bottom of the rect')
  t.ok(art.includes("'matrix(' + scale"), 'the scale is the transform')
  t.absent(art.includes('Animated'), 'enfeites do not animate')
  t.absent(art.includes('Pressable'), 'enfeites are not buttons')
  t.ok(src.includes('Platform.select({ web: false, default: true })'), 'sway driver unchanged')
  t.ok(src.includes('[movingKey, sway]'), 'sway loop deps unchanged')
})
