'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const colors = { accent: 'accent', accentInk: 'accentInk', card: 'card', controlOff: 'controlOff', ink: 'ink' }

function load (name) {
  const source = readFileSync(join(__dirname, '../src/ui', name + '.js'), 'utf8')
  const element = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
    './Icon': { Icon: 'Icon' },
    './theme': { layout: { hit: 44 }, radius: { sm: 8 }, space: { md: 12 }, type: { postText: {} } },
    './ThemeProvider': { useStyles: (make) => make(colors), useTheme: () => ({ colors }) }
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
  return exports
}

function nodes (node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object') return []
  return [node, ...nodes(node.props.children)]
}

function styleOf (node) {
  return Object.assign({}, ...[node.props.style].flat().filter(Boolean))
}

function checkMark (t, mark, { checked, disabled, size, radius }) {
  t.is(mark.type, 'View')
  t.alike(nodes(mark).flatMap(({ props }) => Object.keys(props).filter((key) => /^(?:role$|accessibilityRole$|on[A-Z])/.test(key))), [], 'the mark and its children have no role or handlers')
  t.is(mark.props.accessibilityElementsHidden, true)
  t.is(mark.props.importantForAccessibility, 'no-hide-descendants')
  t.is(mark.props['aria-hidden'], true)
  const style = styleOf(mark)
  t.is(style.width, size)
  t.is(style.height, size)
  t.is(style.borderRadius, radius)
  t.is(style.backgroundColor, checked ? colors.accent : colors.card)
  if (!checked) {
    t.is(style.borderWidth, 2)
    t.is(style.borderColor, colors.controlOff)
    t.is(mark.props.children, null)
  }
  t.is(style.opacity, disabled ? 0.4 : undefined)
}

test('CheckboxMark renders both states as decorative marks', (t) => {
  const { CheckboxMark } = load('Checkbox')
  for (const checked of [false, true]) {
    for (const disabled of [false, true]) {
      const mark = CheckboxMark({ checked, disabled })
      checkMark(t, mark, { checked, disabled, size: 24, radius: 8 })
      if (checked) {
        const icon = mark.props.children
        t.is(icon.type, 'Icon')
        t.is(icon.props.name, 'ok')
        t.is(icon.props.color, colors.accentInk)
      }
    }
  }
})

test('RadioMark renders both states as decorative marks', (t) => {
  const { RadioMark } = load('Radio')
  for (const checked of [false, true]) {
    for (const disabled of [false, true]) {
      const mark = RadioMark({ checked, disabled })
      checkMark(t, mark, { checked, disabled, size: 22, radius: 11 })
      if (checked) {
        const dot = mark.props.children
        t.is(dot.type, 'View')
        t.alike(styleOf(dot), { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accentInk })
      }
    }
  }
})

test('CheckRow exposes exactly one checkbox and its checked and disabled states', (t) => {
  const { CheckRow } = load('Checkbox')
  const label = 'Receber avisos'
  for (const checked of [false, true]) {
    for (const disabled of [false, true]) {
      const row = CheckRow({ checked, disabled, label, onPress () {} })
      const tree = nodes(row)
      t.alike(tree.filter(({ type }) => type === 'Pressable'), [row])
      t.alike(tree.flatMap(({ props }) => [props.role, props.accessibilityRole].filter(Boolean)), ['checkbox'])
      t.is(row.props.accessibilityLabel, label)
      t.alike({ ...row.props.accessibilityState }, { checked, disabled })
      t.is(row.props['aria-checked'], checked)
      t.is(row.props['aria-disabled'], disabled)
      t.is(row.props.disabled, disabled)
      t.is(styleOf(row).minHeight, 44)
      const [mark, text] = row.props.children
      t.is(styleOf(row).opacity, disabled ? 0.45 : undefined, 'a disabled row fades as a whole')
      t.is(styleOf(mark).opacity, undefined, 'the mark does not fade a second time')
      t.is(styleOf(mark).backgroundColor, checked ? colors.accent : colors.card)
      t.is(text.props.children, label)
    }
  }
})

test('CheckRow handles press and both Space key values', (t) => {
  const { CheckRow } = load('Checkbox')
  const calls = []
  const onPress = () => calls.push('press')
  const preventDefault = () => calls.push('prevent')
  const props = { checked: false, label: 'Receber avisos', onPress }
  const row = CheckRow(props)
  row.props.onKeyDown({ key: 'Tab', preventDefault })
  t.alike(calls, [])
  row.props.onPress()
  row.props.onKeyDown({ key: ' ', preventDefault })
  row.props.onKeyDown({ key: 'Spacebar', preventDefault })
  t.alike(calls, ['press', 'prevent', 'press', 'prevent', 'press'])
  const disabled = CheckRow({ ...props, disabled: true })
  disabled.props.onKeyDown({ key: ' ', preventDefault })
  t.alike(calls, ['press', 'prevent', 'press', 'prevent', 'press'])
})

test('CheckRow without onPress ignores Space instead of throwing', (t) => {
  const { CheckRow } = load('Checkbox')
  const row = CheckRow({ checked: false, label: 'Receber avisos' })
  let prevented = 0
  t.execution(() => row.props.onKeyDown({ key: ' ', preventDefault () { prevented++ } }))
  t.is(prevented, 1)
})

test('CheckRow ignores a repeated Space keydown without scrolling', (t) => {
  const { CheckRow } = load('Checkbox')
  for (const key of [' ', 'Spacebar']) {
    const calls = []
    const row = CheckRow({ checked: false, label: 'Receber avisos', onPress () { calls.push('press') } })
    row.props.onKeyDown({ key, repeat: true, preventDefault () { calls.push('prevent') } })
    t.alike(calls, ['prevent'])
  }
})
