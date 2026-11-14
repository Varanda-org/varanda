'use strict'

// Selection haptics: one tap('select') when the choice changes, never when
// the already selected control is pressed again.

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const colors = {
  ink: 'ink',
  bg: 'bg',
  card: 'card',
  accent: 'accent',
  accentSoft: 'accentSoft',
  soft: 'soft',
  line: 'line',
  tabBar: 'tabBar'
}

const theme = {
  layout: { hit: 44, tabBar: 49 },
  motion: { fast: 150 },
  radius: { pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 16 },
  type: { pill: { fontSize: 15, fontWeight: '700', lineHeight: 18 } }
}

function element (type, props) {
  return { type, props }
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props && node.props.children)]
}

function merged (style) {
  const parts = []
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value && typeof value === 'object') parts.push(value)
  }
  walk(style)
  return Object.assign({}, ...parts)
}

function pressables (node) {
  return nodes(node).filter((item) => item.type === 'Pressable')
}

function read (file) {
  return readFileSync(join(__dirname, '../src/ui', file), 'utf8')
}

function compile (source, modules) {
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
  return exports
}

function load (file, extra) {
  const taps = []
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': {
      Animated: {
        Value (value) { this.value = value },
        timing () { return { start () {}, stop () {} } },
        View: 'Animated.View'
      },
      Platform: { OS: 'ios' },
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      StyleSheet: { create (styles) { return styles } },
      Text: 'Text',
      View: 'View'
    },
    react: {
      useEffect () {},
      useRef (value) { return { current: value } }
    },
    './haptics': { tap (kind) { taps.push(kind) } },
    './ThemeProvider': {
      useStyles (make) { return make(colors) },
      useTheme () { return { colors } }
    },
    './theme': theme,
    ...extra
  }
  return { exports: compile(read(file), modules), taps }
}

const chipOptions = [
  { id: 'todas', label: 'Todas' },
  { id: 'nao-lidas', label: 'Não lidas', count: 2 }
]

test('FilterChips taps select once when the chip changes and not on a reselect', (t) => {
  const { exports, taps } = load('FilterChips.js')
  const picked = []
  const view = exports.FilterChips({
    options: chipOptions,
    selected: 'todas',
    onSelect (id) { picked.push(id) }
  })
  const [todas, unread] = pressables(view)
  t.alike(taps, [], 'rendering does not tap')
  todas.props.onPress()
  t.alike(picked, ['todas'], 'a reselect still reports the chip')
  t.alike(taps, [], 'a reselect does not tap')
  unread.props.onPress()
  t.alike(picked, ['todas', 'nao-lidas'])
  t.alike(taps, ['select'])
  const next = exports.FilterChips({
    options: chipOptions,
    selected: 'nao-lidas',
    onSelect (id) { picked.push(id) }
  })
  pressables(next)[1].props.onPress()
  t.alike(picked, ['todas', 'nao-lidas', 'nao-lidas'])
  t.alike(taps, ['select'], 'pressing the chip that is now selected does not tap again')
  pressables(next)[0].props.onPress()
  t.alike(taps, ['select', 'select'], 'a later change taps once more')
  t.alike(picked, ['todas', 'nao-lidas', 'nao-lidas', 'todas'])
})

test('a selected FilterChips chip is an ink fill with a bg-coloured label', (t) => {
  const { exports } = load('FilterChips.js')
  const view = exports.FilterChips({ options: chipOptions, selected: 'nao-lidas', onSelect () {} })
  const chips = nodes(view).filter((item) => item.type === 'View' && merged(item.props.style).backgroundColor)
  t.is(chips.length, 2)
  const selected = chips.find((item) => merged(item.props.style).backgroundColor === 'ink')
  const idle = chips.find((item) => merged(item.props.style).backgroundColor === 'card')
  t.ok(selected, 'the selected chip is filled with ink')
  t.is(merged(selected.props.style).borderColor, 'ink', 'the border matches the fill')
  const selectedLabel = nodes(selected).find((item) => item.type === 'Text')
  t.is(merged(selectedLabel.props.style).color, 'bg')
  t.is(selectedLabel.props.children, 'Não lidas 2')
  t.is(merged(idle.props.style).backgroundColor, 'card')
  t.is(merged(idle.props.style).borderColor, 'line')
  t.is(nodes(idle).find((item) => item.type === 'Text').props.children, 'Todas')
  t.is(merged(nodes(idle).find((item) => item.type === 'Text').props.style).color, 'ink')
  const buttons = pressables(view)
  t.alike({ ...buttons[1].props.accessibilityState }, { selected: true })
  t.is(buttons[1].props.accessibilityLabel, 'Não lidas, 2')
  t.alike({ ...buttons[0].props.accessibilityState }, { selected: false })
})

test('Segmented taps select once when the tab changes and not on a reselect', (t) => {
  const { exports, taps } = load('Segmented.js')
  const picked = []
  const options = [
    { id: 'posts', label: 'Publicações' },
    { id: 'mural', label: 'Mural' }
  ]
  const view = exports.Segmented({ options, selected: 'posts', onSelect (id) { picked.push(id) } })
  const [posts, mural] = pressables(view)
  t.is(posts.props.accessibilityRole, 'tab')
  t.alike({ ...posts.props.accessibilityState }, { selected: true })
  t.is(posts.props['aria-selected'], true)
  t.is(mural.props['aria-selected'], false)
  t.alike(taps, [])
  posts.props.onPress()
  t.alike(picked, ['posts'], 'a reselect still reports the tab')
  t.alike(taps, [])
  mural.props.onPress()
  t.alike(picked, ['posts', 'mural'])
  t.alike(taps, ['select'])
  const next = exports.Segmented({ options, selected: 'mural', onSelect (id) { picked.push(id) } })
  pressables(next)[1].props.onPress()
  t.alike(taps, ['select'])
  t.alike(picked, ['posts', 'mural', 'mural'])
  pressables(next)[0].props.onPress()
  t.alike(taps, ['select', 'select'])
})

test('TabBar taps select once when the tab changes and not on a reselect', (t) => {
  const pending = { cancels: 0 }
  const { exports, taps } = load('TabBar.js', {
    'react-native-safe-area-context': {
      useSafeAreaInsets () { return { top: 0, right: 0, bottom: 0, left: 0 } }
    },
    './Avatar': { Avatar: 'Avatar' },
    './Icon': { Icon: 'Icon' },
    './StackLayer': { useReduceMotion () { return false } },
    './chromeMotion': { useChromeMotion () { return { progress: { interpolate () { return 0 } }, hidden: false, show () {} } } },
    '../chromeScroll': { chromeHiddenProps () { return {} } },
    '../appearance': {
      paletteFor () {
        return colors
      }
    },
    '../tabs': { TABS: [], tabsFor () { return [] } },
    '../doubleTap': { pendingOpen: { cancel () { pending.cancels += 1 } } }
  })
  const tabs = [
    { id: 'rua', label: 'A Rua', icon: 'rua' },
    { id: 'diario', label: 'Diário', icon: 'pessoa' }
  ]
  const chosen = []
  const reselected = []
  const props = {
    tabs,
    onSelect (id) { chosen.push(id) },
    onReselect (id) { reselected.push(id) }
  }
  const bar = exports.TabBar({ ...props, current: 'rua' })
  const rua = pressables(bar).find((item) => item.props.accessibilityLabel === 'A Rua')
  const diario = pressables(bar).find((item) => item.props.accessibilityLabel === 'Diário')
  t.alike(taps, [])
  rua.props.onPress()
  t.alike(reselected, ['rua'])
  t.alike(chosen, [], 'a reselect does not call onSelect')
  t.alike(taps, [])
  diario.props.onPress()
  t.alike(chosen, ['diario'])
  t.alike(reselected, ['rua'])
  t.alike(taps, ['select'])
  t.is(pending.cancels, 2, 'each press still cancels a pending open')
  const next = exports.TabBar({ ...props, current: 'diario' })
  pressables(next).find((item) => item.props.accessibilityLabel === 'Diário').props.onPress()
  t.alike(taps, ['select'])
  t.alike(reselected, ['rua', 'diario'])
  t.alike(chosen, ['diario'])
  pressables(next).find((item) => item.props.accessibilityLabel === 'A Rua').props.onPress()
  t.alike(taps, ['select', 'select'])
  t.alike(chosen, ['diario', 'rua'])
})

test('selection sources tap select once and leave the tab chrome in place', (t) => {
  for (const file of ['TabBar.js', 'FilterChips.js', 'Segmented.js']) {
    const src = read(file)
    t.absent(src.includes('\u2014'), file + ' has no em dash')
    t.ok(src.includes("import { tap } from './haptics'"), file + ' uses the shared tap')
    t.absent(src.includes('expo-haptics'), file + ' does not import expo-haptics')
    t.is(src.split("tap('select')").length - 1, 1, file + ' calls tap select once')
  }
  const tab = read('TabBar.js')
  const handler = tab.slice(tab.indexOf('onPress={() => {'), tab.indexOf('style={styles.tab}'))
  const reselect = handler.slice(handler.indexOf('if (selected)'), handler.indexOf('} else {'))
  t.absent(reselect.includes("tap('select')"), 'a reselect does not tap')
  t.ok(handler.includes("tap('select')"), 'changing tabs taps inside the press')
  t.ok(tab.includes('const TAB_ICON = 27'), 'icon size stays')
  t.ok(tab.includes('backgroundColor: colors.accentSoft'), 'the active pill stays accentSoft')
  t.ok(tab.includes('borderRadius: radius.pill'), 'pill radius stays')
  t.ok(tab.includes('<Icon name={tab.icon} size={TAB_ICON}'), 'the glyphs stay on TAB_ICON')
  t.ok(tab.includes("const alwaysDark = Platform.OS === 'web'"), 'the web bar stays dark')
  const chips = read('FilterChips.js')
  t.ok(chips.includes('backgroundColor: colors.ink'), 'selected chip is an ink fill')
  t.ok(chips.includes('borderColor: colors.ink'), 'the ink fill covers the border')
  t.ok(chips.includes('color: colors.bg'), 'selected label uses the bg colour')
  t.absent(chips.includes('colors.accentSoft'), 'the selected chip no longer uses accentSoft')
  t.ok(chips.includes("if (!on) tap('select')"), 'only a chip that is not selected taps')
  t.ok(/row: \{[^}]*paddingVertical: space\.sm/.test(chips), 'chip row keeps its vertical padding')
  const segmented = read('Segmented.js')
  t.ok(segmented.includes("if (!on) tap('select')"), 'only a tab that is not selected taps')
  t.ok(segmented.includes("accessibilityRole='tab'"), 'tab role stays')
  t.ok(segmented.includes('accessibilityState={{ selected: on }}'), 'selected state stays')
  t.ok(segmented.includes('aria-selected={on}'), 'web selected state stays')
})
