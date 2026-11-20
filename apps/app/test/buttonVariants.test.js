'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

function compile (file, modules) {
  const { code } = transformSync(readFileSync(join(__dirname, '../src/ui', file), 'utf8'), {
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

function load () {
  const element = (type, props) => ({ type, props })
  const colors = Object.fromEntries(['accent', 'accentInk', 'accentSoft', 'ink', 'soft', 'inputOff', 'outline', 'danger', 'dangerSoft'].map((key) => [key, key]))
  const modules = {
    react: {},
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      Pressable: 'Pressable',
      Text: 'Text',
      View: 'View',
      Platform: { select: (values) => values.default },
      StyleSheet: { create: (styles) => styles, absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } }
    },
    'react-native-safe-area-context': {},
    '@varanda/rpc': {},
    '../devices': {},
    '../pressMotion': { PRESSED_OPACITY: 0.7 },
    '../dayClock': {},
    '../visibleNow': {},
    '../tabs': {},
    './Icon': { Icon: 'Icon' },
    './screenVisible': {},
    './fieldHeight': {},
    './fieldMeasure': {},
    './ThemeProvider': { useStyles: (make) => make(colors), useTheme: () => ({ colors }) }
  }
  modules['./theme'] = compile('theme.js', modules)
  return { ...compile('index.js', modules), ...compile('Pill.js', modules), ...modules['./theme'] }
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (typeof node.type === 'function') return nodes(node.type(node.props))
  return [node, ...nodes(node.props?.children)]
}

function styleOf (node) {
  const style = typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
}

const { Pill, Btn, Spinner, layout, space } = load()

test('Pill weak uses brand colours and filled padding', (t) => {
  const pill = Pill({ label: 'Seguir', icon: 'mais', iconEnd: 'escolher', weak: true })
  const style = styleOf(pill)
  const filled = styleOf(Pill({ label: 'Seguir', filled: true }))
  t.is(style.backgroundColor, 'accentSoft')
  t.absent(style.borderWidth)
  t.is(style.paddingHorizontal, filled.paddingHorizontal)
  t.is(style.paddingVertical, filled.paddingVertical)
  t.is(styleOf(nodes(pill).find((node) => node.type === 'Text')).color, 'accent')
  for (const icon of nodes(pill).filter((node) => node.type === 'Icon')) t.is(icon.props.color, 'accent')
})

test('Pill link has no fill or border and keeps the hit target', (t) => {
  for (const small of [false, true]) {
    const pill = Pill({ label: 'Saiba mais', icon: 'mais', link: true, small })
    const face = small ? pill.props.children : pill
    const style = styleOf(face)
    t.absent(style.backgroundColor)
    t.absent(style.borderWidth)
    t.is(style.paddingHorizontal, space.md)
    t.ok(styleOf(pill).minWidth >= layout.hit)
    t.ok(styleOf(pill).minHeight >= layout.hit)
    t.is(styleOf(nodes(pill).find((node) => node.type === 'Text')).color, 'accent')
    t.is(nodes(pill).find((node) => node.type === 'Icon').props.color, 'accent')
  }
})

test('Pill danger with tonal is Error Weak while danger alone stays outlined', (t) => {
  const pill = Pill({ label: 'Apagar', icon: 'lixeira', danger: true, tonal: true })
  const style = styleOf(pill)
  t.is(style.backgroundColor, 'dangerSoft')
  t.absent(style.borderWidth)
  t.is(styleOf(nodes(pill).find((node) => node.type === 'Text')).color, 'danger')
  t.is(nodes(pill).find((node) => node.type === 'Icon').props.color, 'danger')
  const outline = styleOf(Pill({ label: 'Apagar', danger: true }))
  t.absent(outline.backgroundColor)
  t.is(outline.borderWidth, 1.5)
  t.is(outline.borderColor, 'danger')
  const neutral = Pill({ label: 'Cancelar', tonal: true })
  t.is(styleOf(neutral).backgroundColor, 'inputOff')
  t.is(styleOf(nodes(neutral).find((node) => node.type === 'Text')).color, 'soft')
})

test('Pill small uses 16 pt icons and default uses 18 pt icons', (t) => {
  for (const small of [false, true]) {
    const pill = Pill({ label: 'Escolher', icon: 'mais', iconEnd: 'escolher', small })
    const icons = nodes(pill).filter((node) => node.type === 'Icon')
    t.is(icons.length, 2)
    for (const icon of icons) t.is(icon.props.size, small ? 16 : 18)
  }
})

function checkPending (t, render, props) {
  const idle = render({ ...props, pending: false })
  const busy = render({ ...props, pending: true })
  const idleTree = nodes(idle)
  const busyTree = nodes(busy)
  const idleLabel = idleTree.find((node) => node.type === 'Text')
  const busyLabel = busyTree.find((node) => node.type === 'Text')
  t.is(busyLabel.props.children, props.label, 'the label has no added ellipsis')
  t.is(styleOf(busyLabel).opacity, 0)
  const { opacity, ...busyStyle } = styleOf(busyLabel)
  t.alike(busyStyle, styleOf(idleLabel), 'hidden text retains all layout styles')
  const { opacity: off, ...busyFace } = styleOf(busy)
  t.alike(busyFace, styleOf(idle), 'the target retains its layout')
  if (props.small) t.alike(styleOf(busy.props.children), styleOf(idle.props.children), 'the small face retains its layout')
  t.is(busy.props.disabled, true)
  t.is(busy.props.accessibilityState.disabled, true)
  t.is(busy.props.accessibilityState.busy, true)
  t.is(idle.props.accessibilityState.busy, false)
  t.is(busy.props['aria-busy'], true, 'the web hears busy too')
  t.absent(idle.props['aria-busy'])
  t.absent(idleTree.some((node) => node.type === 'ActivityIndicator'))
  const spinners = busyTree.filter((node) => node.type === 'ActivityIndicator')
  t.is(spinners.length, 1)
  if (spinners.length !== 1) return
  t.is(spinners[0].props.color, styleOf(busyLabel).color)
  const overlay = busyTree.find((node) => node.props.pointerEvents === 'none')
  t.alike(styleOf(overlay), { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' }, 'the centred spinner occupies no layout space')
  t.is(overlay.props['aria-hidden'], true, 'web screen readers skip the spinner')
  for (const icon of busyTree.filter((node) => node.type === 'Icon')) t.is(styleOf(icon).opacity, 0)
}

test('Pill pending preserves label geometry and announces busy in every variant', (t) => {
  for (const variant of [{}, { filled: true }, { weak: true }, { link: true }, { tonal: true }, { danger: true }, { danger: true, tonal: true }]) {
    for (const small of [false, true]) checkPending(t, Pill, { label: 'Salvar alterações', icon: 'mais', iconEnd: 'escolher', small, ...variant })
  }
  for (const selected of [undefined, false, true]) {
    const pill = Pill({ label: 'Escolher', pending: true, selected })
    t.is(Object.hasOwn(pill.props.accessibilityState, 'selected'), selected !== undefined)
    t.is(pill.props.accessibilityState.selected, selected)
    t.is(pill.props['aria-pressed'], selected)
  }
  const iconOnly = Pill({ icon: 'mais', accessibilityLabel: 'Adicionar', pending: true, small: true })
  t.is(iconOnly.props.accessibilityLabel, 'Adicionar')
  t.absent(nodes(iconOnly).some((node) => node.type === 'Text'))
  t.is(nodes(iconOnly).filter((node) => node.type === 'ActivityIndicator').length, 1)
  t.is(styleOf(nodes(iconOnly).find((node) => node.type === 'Icon')).opacity, 0)
})

test('Btn pending preserves label geometry and uses the label colour', (t) => {
  for (const variant of [{}, { secondary: true }, { danger: true }]) {
    for (const size of [{}, { small: true }, { large: true }, { block: true }]) {
      checkPending(t, Btn, { label: 'Salvar alterações', ...variant, ...size })
      checkPending(t, Btn, { label: 'Salvar alterações', icon: 'mais', ...variant, ...size })
    }
  }
  t.is(Btn({ label: 'Abrir', pending: true, expanded: true }).props.accessibilityState.expanded, true)
})

test('Spinner accepts a colour and otherwise uses the theme accent', (t) => {
  t.is(Spinner({}).props.color, 'accent')
  t.is(Spinner({}).props.size, 'small')
  t.is(Spinner({ color: 'danger', size: 'large' }).props.color, 'danger')
  t.is(Spinner({ color: 'danger', size: 'large' }).props.size, 'large')
})
