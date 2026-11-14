'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const source = readFileSync(join(__dirname, '../src/ui/SwitchRow.js'), 'utf8')

function load () {
  const taps = []
  const element = (type, props) => ({ type, props })
  const colors = { ink: 'ink', soft: 'soft', accent: 'accent', line: 'line', card: 'card', skeleton: 'skeleton' }
  const modules = {
    react: { useId: () => 'switch-caption-id' },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 } },
    './haptics': { tap: (kind) => taps.push(kind) },
    './theme': { layout: { hit: 44 }, space: { xs: 4, md: 12, lg: 16 }, type: { postText: {}, replyMark: {} } },
    './ThemeProvider': { useStyles: (make) => make(colors) }
  }
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }], require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const exports = {}
  runInNewContext(code, {
    exports,
    require (name) {
      if (!Object.hasOwn(modules, name)) throw new Error('Unexpected import: ' + name)
      return modules[name]
    }
  })
  return { render: exports.SwitchRow, taps }
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props?.children)]
}

function styleOf (node) {
  return Object.assign({}, ...[node.props.style].flat().filter(Boolean))
}

test('SwitchRow exposes one switch with its label, caption and checked state', (t) => {
  const { render } = load()
  for (const value of [false, true]) {
    const row = render({ label: 'Notificações', caption: 'Avisar sobre respostas', value, onValueChange () {} })
    const tree = nodes(row)
    const hidden = tree.find((node) => node.props.pointerEvents === 'none')
    const thumb = hidden.props.children
    t.is(row.type, 'Pressable')
    t.is(row.props.accessible, true)
    t.is(row.props.accessibilityRole, 'switch')
    t.is(row.props.accessibilityLabel, 'Notificações')
    t.is(row.props.accessibilityHint, 'Avisar sobre respostas')
    const caption = tree.find((node) => node.type === 'Text' && node.props.children === 'Avisar sobre respostas')
    t.is(typeof caption.props.nativeID, 'string')
    t.ok(caption.props.nativeID?.length > 0, 'the caption has a non-empty id')
    t.is(row.props['aria-describedby'], caption.props.nativeID)
    t.alike({ ...row.props.accessibilityState }, { checked: value, disabled: false })
    t.is(row.props['aria-checked'], value)
    t.is(row.props['aria-disabled'], false)
    t.is(tree.filter((node) => node.props.accessibilityRole === 'switch').length, 1)
    t.absent(tree.some((node) => node.type === 'Switch'), 'no native switch or nested web input')
    t.is(hidden.type, 'View', 'the indicator cannot become a second tab stop')
    t.is(hidden.props.pointerEvents, 'none')
    t.is(hidden.props.accessibilityElementsHidden, true)
    t.is(hidden.props.importantForAccessibility, 'no-hide-descendants')
    t.is(hidden.props['aria-hidden'], true)
    const trackStyle = styleOf(hidden)
    t.is(trackStyle.backgroundColor, value ? 'accent' : 'line')
    t.is(trackStyle.alignItems, value ? 'flex-end' : 'flex-start', 'the thumb follows the checked state')
    t.is(trackStyle.width, 51)
    t.is(trackStyle.height, 31)
    t.ok(trackStyle.borderRadius >= trackStyle.height / 2, 'the track is fully rounded')
    t.is(thumb.type, 'View')
    const thumbStyle = styleOf(thumb)
    t.is(thumbStyle.width, 27)
    t.is(thumbStyle.height, 27)
    t.ok(thumbStyle.borderRadius >= thumbStyle.height / 2, 'the thumb is round')
    t.is(thumbStyle.backgroundColor, 'card')
    t.is(thumbStyle.borderColor, 'line')
    t.is(thumbStyle.borderWidth, 0.5, 'the thumb uses a hairline border')
    t.absent(tree.slice(1).some((node) => node.props.onPress || node.props.onValueChange || node.props.onKeyDown), 'only the row handles gestures')
  }
})

test('SwitchRow changes only on an explicit gesture and taps once per change', (t) => {
  const { render, taps } = load()
  const changes = []
  const props = { label: 'Notificações', onValueChange: (next) => changes.push(next) }
  const off = render(props)
  t.alike(changes, [], 'rendering does not change the value')
  t.alike(taps, [])
  off.props.onPress()
  t.alike(changes, [true])
  t.alike(taps, ['select'])
  const on = render({ ...props, value: true })
  t.alike(changes, [true], 'a controlled update does not call back')
  on.props.onPress()
  t.alike(changes, [true, false])
  on.props.onKeyDown?.({ key: 'ArrowRight', preventDefault () { t.fail('another key must keep its default behavior') } })
  t.alike(changes, [true, false], 'another key does not change the value')
  t.alike(taps, ['select', 'select'])
  on.props.onKeyDown?.({ key: ' ', preventDefault () {} })
  t.alike(changes, [true, false, false])
  t.alike(taps, ['select', 'select', 'select'])
})

test('SwitchRow handles both Space keys once and prevents their default behavior', (t) => {
  for (const key of [' ', 'Spacebar']) {
    for (const value of [false, true]) {
      const { render, taps } = load()
      const changes = []
      let prevented = 0
      const row = render({ label: 'Notificações', value, onValueChange: (next) => changes.push(next) })
      t.is(typeof row.props.onKeyDown, 'function')
      row.props.onKeyDown?.({ key, preventDefault () { prevented++ } })
      t.alike(changes, [!value], 'Space toggles once')
      t.alike(taps, ['select'], 'Space taps once')
      t.is(prevented, 1)
    }
  }
})

test('SwitchRow prevents repeated Space keydowns without changing or tapping', (t) => {
  for (const key of [' ', 'Spacebar']) {
    for (const value of [false, true]) {
      const { render, taps } = load()
      const changes = []
      let prevented = 0
      const row = render({ label: 'Notificações', value, onValueChange: (next) => changes.push(next) })
      row.props.onKeyDown({ key, repeat: true, preventDefault () { prevented++ } })
      t.is(prevented, 1)
      t.alike(changes, [])
      t.alike(taps, [])
    }
  }
})

test('SwitchRow toggles and taps once when Space repeats after a controlled update', (t) => {
  for (const key of [' ', 'Spacebar']) {
    for (const value of [false, true]) {
      const { render, taps } = load()
      const changes = []
      const props = { label: 'Notificações', onValueChange: (next) => changes.push(next) }
      let prevented = 0
      const row = render({ ...props, value })
      row.props.onKeyDown({ key, repeat: false, preventDefault () { prevented++ } })
      const updated = render({ ...props, value: changes[0] })
      updated.props.onKeyDown({ key, repeat: true, preventDefault () { prevented++ } })
      t.is(prevented, 2)
      t.alike(changes, [!value])
      t.alike(taps, ['select'])
    }
  }
})

test('SwitchRow disables both entry points without haptics or callbacks', (t) => {
  const { render, taps } = load()
  const changes = []
  const row = render({ label: 'Notificações', value: true, disabled: true, onValueChange: (next) => changes.push(next) })
  t.is(row.props.disabled, true)
  t.alike({ ...row.props.accessibilityState }, { checked: true, disabled: true })
  t.is(row.props.onKeyDown, undefined, 'a disabled row has no keyboard handler')
  t.is(Object.assign({}, ...row.props.style({ pressed: false }).filter(Boolean)).opacity, 0.45, 'disabled rows keep the fade')
  let prevented = 0
  row.props.onPress()
  for (const key of [' ', 'Spacebar']) row.props.onKeyDown?.({ key, preventDefault () { prevented++ } })
  t.alike(changes, [])
  t.alike(taps, [])
  t.is(prevented, 0, 'disabled Space does nothing')
  const readonly = render({ label: 'Notificações' })
  t.is(readonly.props.disabled, true)
  t.is(readonly.props.onKeyDown, undefined, 'a read-only row has no keyboard handler')
  readonly.props.onPress()
  readonly.props.onKeyDown?.({ key: ' ', preventDefault () { prevented++ } })
  t.is(prevented, 0)
  t.alike(taps, [])
})

test('SwitchRow keeps optional and long copy flexible inside a 44 pt target', (t) => {
  const { render } = load()
  const row = render({ label: 'Notificações '.repeat(20), onValueChange () {} })
  const texts = nodes(row).filter((node) => node.type === 'Text')
  t.is(row.props['aria-describedby'], undefined, 'no description reference without a caption')
  t.is(texts.length, 1, 'no empty caption')
  t.is(texts[0].props.children, 'Notificações '.repeat(20))
  t.absent(texts[0].props.numberOfLines)
  t.absent(texts[0].props.style.height)
  const style = Object.assign({}, ...row.props.style({ pressed: false }).filter(Boolean))
  t.ok(style.minHeight >= 44)
  t.absent(style.height, 'large text can grow the row')
  t.absent(/\b(?:Platform|window|document|navigator|fetch|setTimeout|setInterval)\b/.test(source), 'no platform gates, browser calls or automatic work')
})
