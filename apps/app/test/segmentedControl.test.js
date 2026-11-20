'use strict'

// Selection on the pill track: one tap('select') when the choice changes,
// never when the already selected item is pressed again.

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const colors = {
  ink: 'ink',
  card: 'card',
  inputOff: 'inputOff',
  soft: 'soft'
}

function element (type, props) {
  return { type, props }
}

function nodes (node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object') return []
  return [node, ...nodes(node.props && node.props.children)]
}

function styleOf (node) {
  const { style } = node.props
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style
  return Object.assign({}, ...[resolved].flat().filter((part) => part && typeof part === 'object'))
}

function pressables (node) {
  return nodes(node).filter((item) => item.type === 'Pressable')
}

function faceOf (node) {
  return nodes(node.props.children).find((item) => item.type === 'View')
}

function textOf (node) {
  return nodes(node).find((item) => item.type === 'Text')
}

function load () {
  const taps = []
  const source = readFileSync(join(__dirname, '../src/ui/SegmentedControl.js'), 'utf8')
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': {
      Pressable: 'Pressable',
      StyleSheet: { create (styles) { return styles } },
      Text: 'Text',
      View: 'View'
    },
    './haptics': { tap (kind) { taps.push(kind) } },
    './ThemeProvider': { useStyles (make) { return make(colors) } },
    './theme': {
      radius: { pill: 999 },
      space: { xs: 4 },
      type: { more: { fontSize: 14, lineHeight: 20, fontWeight: '600' } }
    }
  }
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [
      [require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
      require.resolve('@babel/plugin-transform-modules-commonjs')
    ]
  })
  const exports = {}
  runInNewContext(code, {
    exports,
    require (name) {
      if (!Object.hasOwn(modules, name)) throw new Error('Unexpected import: ' + name)
      return modules[name]
    }
  })
  return { SegmentedControl: exports.SegmentedControl, taps, source }
}

const options = [
  { id: 'track', label: 'Faixas' },
  { id: 'playlist', label: 'Playlists' }
]

const SHADOW = ['shadowColor', 'shadowOffset', 'shadowOpacity', 'shadowRadius', 'elevation', 'boxShadow']

test('SegmentedControl marks the selected tab on a flat pill track', (t) => {
  const { SegmentedControl, source } = load()
  t.absent(source.includes('\u2014'), 'no em dash')
  t.is(source.split("tap('select')").length - 1, 1, 'one select tap')
  t.ok(source.includes("if (!on) tap('select')"), 'only an item that is not selected taps')
  t.absent(source.includes('hitSlop='), 'no touch slop, which react-native-web drops')
  const view = SegmentedControl({ options, selected: 'track', onSelect () {} })
  t.is(view.type, 'View')
  t.is(view.props.accessibilityRole, 'tablist')
  const track = styleOf(view)
  t.is(track.minHeight, 48)
  t.is(track.paddingHorizontal, 4)
  t.is(track.padding, undefined, 'no vertical track padding: the item spans the 48 pt row')
  t.is(track.borderRadius, 999)
  t.is(track.backgroundColor, 'inputOff')
  const [faixas, playlists] = pressables(view)
  t.is(faixas.props.accessibilityRole, 'tab')
  t.is(playlists.props.accessibilityRole, 'tab')
  t.alike({ ...faixas.props.accessibilityState }, { selected: true })
  t.alike({ ...playlists.props.accessibilityState }, { selected: false })
  t.is(faixas.props['aria-selected'], true)
  t.is(playlists.props['aria-selected'], false)
  t.is(faixas.props.accessibilityLabel, 'Faixas')
  t.is(playlists.props.accessibilityLabel, 'Playlists')
  t.is(styleOf(faixas).flex, 1)
  t.is(styleOf(faixas).paddingVertical, 4, 'the item insets its face by 4 pt and takes the touch over the whole row')
  t.is(styleOf(playlists).paddingVertical, 4)
  t.is(styleOf(faixas).backgroundColor, undefined, 'the fill is on the face, inside the inset')
  const onItem = styleOf(faceOf(faixas))
  const offItem = styleOf(faceOf(playlists))
  t.is(onItem.flex, 1)
  t.is(onItem.borderRadius, 999)
  t.is(offItem.borderRadius, 999)
  t.is(onItem.backgroundColor, 'card')
  t.is(offItem.backgroundColor, undefined)
  for (const key of SHADOW) t.is(onItem[key], undefined, 'active item has no ' + key)
  const onText = styleOf(textOf(faixas))
  const offText = styleOf(textOf(playlists))
  t.is(textOf(faixas).props.children, 'Faixas')
  t.is(textOf(playlists).props.children, 'Playlists')
  t.is(onText.fontSize, 14)
  t.is(onText.lineHeight, 20)
  t.is(onText.fontWeight, '600')
  t.is(offText.fontSize, 14)
  t.is(offText.lineHeight, 20)
  t.is(offText.fontWeight, '600')
  t.is(onText.color, 'ink')
  t.is(offText.color, 'soft')
  t.is(textOf(faixas).props.maxFontSizeMultiplier, 1.5, 'large text stops at 1.5, like two Segmented tabs')
  t.is(textOf(faixas).props.numberOfLines, 1)
  const empty = SegmentedControl({ selected: 'track', onSelect () {} })
  t.is(empty.props.accessibilityRole, 'tablist')
  t.alike(pressables(empty), [])
})

test('SegmentedControl taps select once when the choice changes and not on a reselect', (t) => {
  const { SegmentedControl, taps } = load()
  const picked = []
  const view = SegmentedControl({ options, selected: 'track', onSelect (id) { picked.push(id) } })
  const [faixas, playlists] = pressables(view)
  t.alike(taps, [], 'rendering does not tap')
  faixas.props.onPress()
  t.alike(picked, ['track'], 'a reselect still reports the item')
  t.alike(taps, [], 'a reselect does not tap')
  playlists.props.onPress()
  t.alike(picked, ['track', 'playlist'])
  t.alike(taps, ['select'])
  const next = SegmentedControl({ options, selected: 'playlist', onSelect (id) { picked.push(id) } })
  const again = pressables(next)
  t.alike({ ...again[1].props.accessibilityState }, { selected: true })
  t.alike({ ...again[0].props.accessibilityState }, { selected: false })
  t.is(again[1].props['aria-selected'], true)
  t.is(again[0].props['aria-selected'], false)
  t.is(styleOf(faceOf(again[1])).backgroundColor, 'card')
  t.is(styleOf(faceOf(again[0])).backgroundColor, undefined)
  t.is(styleOf(textOf(again[1])).color, 'ink')
  t.is(styleOf(textOf(again[0])).color, 'soft')
  again[1].props.onPress()
  t.alike(taps, ['select'], 'pressing the item that is now selected does not tap again')
  t.alike(picked, ['track', 'playlist', 'playlist'])
  again[0].props.onPress()
  t.alike(taps, ['select', 'select'], 'a later change taps once more')
  t.alike(picked, ['track', 'playlist', 'playlist', 'track'])
})
