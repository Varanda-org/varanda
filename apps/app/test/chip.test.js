'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const colors = { bg: 'bg', ink: 'ink', card: 'card', line: 'line' }
const pill = { fontSize: 15, fontWeight: '600', lineHeight: 18 }

function load () {
  const source = readFileSync(join(__dirname, '../src/ui/Chip.js'), 'utf8')
  const element = (type, props) => ({ type, props })
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': {
      Pressable: 'Pressable',
      Text: 'Text',
      View: 'View',
      StyleSheet: { create: (styles) => styles }
    },
    './Icon': { Icon: 'Icon' },
    './ThemeProvider': { useStyles: (make) => make(colors), useTheme: () => ({ colors }) },
    './theme': { layout: { hit: 44 }, radius: { pill: 999 }, space: { xs: 4, md: 12 }, type: { pill } }
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
  return exports.Chip
}

const Chip = load()

function styleOf (node, pressed = false) {
  const style = node.props.style
  return Object.assign({}, ...(typeof style === 'function' ? style({ pressed }) : style))
}

function controls (node) {
  if (Array.isArray(node)) return node.flatMap(controls)
  if (!node || typeof node !== 'object') return []
  const { accessibilityRole, children } = node.props
  return [...(node.type === 'Pressable' || accessibilityRole ? [node.type] : []), ...controls(children)]
}

test('Chip renders one button with a 44 pt target and a 32 pt face', (t) => {
  const chip = Chip({ label: 'Todas' })
  const face = chip.props.children
  const [icon, label] = face.props.children
  t.alike(controls(chip), ['Pressable'])
  t.is(chip.props.accessibilityRole, 'button')
  t.is(chip.props.accessibilityLabel, 'Todas')
  t.alike({ ...chip.props.accessibilityState }, { selected: false, disabled: false })
  t.is(chip.props['aria-pressed'], false)
  t.is(chip.props['aria-checked'], undefined)
  t.is(styleOf(chip).minHeight, 44)
  t.is(face.type, 'View')
  t.alike(styleOf(face), {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'line',
    backgroundColor: 'card',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  })
  t.is(icon, null)
  t.is(label.type, 'Text')
  t.is(label.props.children, 'Todas')
  t.is(label.props.numberOfLines, 1)
  t.alike(styleOf(label), { ...pill, color: 'ink', flexShrink: 1 })
})

test('Chip renders a selected button with an icon before the label', (t) => {
  let presses = 0
  const chip = Chip({ label: 'Não lidas 2', selected: true, icon: 'sino', accessibilityLabel: 'Não lidas, 2', onPress () { presses++ } })
  const face = chip.props.children
  const [icon, label] = face.props.children
  t.alike(controls(chip), ['Pressable'])
  t.is(chip.props.accessibilityLabel, 'Não lidas, 2')
  t.alike({ ...chip.props.accessibilityState }, { selected: true, disabled: false })
  t.is(chip.props['aria-pressed'], true)
  t.is(chip.props['aria-checked'], undefined)
  t.is(styleOf(face).backgroundColor, 'ink')
  t.is(styleOf(face).borderColor, 'ink')
  t.is(icon.type, 'Icon')
  t.alike({ ...icon.props }, { name: 'sino', size: 16, color: 'bg' })
  t.is(label.type, 'Text')
  t.is(styleOf(label).color, 'bg')
  chip.props.onPress()
  t.is(presses, 1)
})

test('Chip renders one radio with checked state and handles Space once', (t) => {
  for (const selected of [false, true]) {
    let presses = 0
    let prevented = 0
    const chip = Chip({ label: 'Recentes', role: 'radio', selected, onPress () { presses++ } })
    t.alike(controls(chip), ['Pressable'])
    t.is(chip.props.accessibilityRole, 'radio')
    t.alike({ ...chip.props.accessibilityState }, { checked: selected, disabled: false })
    t.is(chip.props['aria-checked'], selected)
    t.is(chip.props['aria-pressed'], undefined)
    const event = { key: ' ', preventDefault () { prevented++ } }
    chip.props.onKeyDown(event)
    chip.props.onKeyDown({ ...event, repeat: true })
    chip.props.onKeyDown({ ...event, key: 'ArrowRight' })
    t.is(presses, 1)
    t.is(prevented, 2)
  }
})

test('Chip forwards disabled to the press target and dims either role', (t) => {
  for (const role of ['button', 'radio']) {
    const chip = Chip({ label: 'Recentes', role, selected: true, disabled: true })
    t.is(chip.props.disabled, true)
    t.is(chip.props.accessibilityState.disabled, true)
    t.is(chip.props.onKeyDown, undefined)
    t.is(styleOf(chip).opacity, 0.45)
  }
})
