'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const source = readFileSync(join(__dirname, '../src/ui/NoteBar.js'), 'utf8')

function load () {
  const element = (type, props) => ({ type, props })
  const colors = { soft: 'soft', accent: 'accent', warm: 'warm', line: 'line' }
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    './Icon': { Icon: 'Icon' },
    './theme': { layout: { hit: 44 }, space: { xs: 4, sm: 8, lg: 16 }, type: { replyMark: {} } },
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
  return exports.NoteBar
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props?.children)]
}

const styleOf = (node) => typeof node.props.style === 'function'
  ? Object.assign({}, ...node.props.style({ pressed: false }).filter(Boolean))
  : Array.isArray(node.props.style) ? Object.assign({}, ...node.props.style.filter(Boolean)) : node.props.style

test('NoteBar wraps long text without requiring an icon or controls', (t) => {
  const render = load()
  const text = 'Uma atualização está disponível. '.repeat(20)
  const row = render({ text })
  const tree = nodes(row)
  const copy = tree.find((node) => node.type === 'Text')
  const content = tree.find((node) => node.props.style?.flexWrap === 'wrap')
  t.is(row.type, 'View')
  t.is(copy.props.children, text)
  t.absent(copy.props.numberOfLines)
  t.absent(copy.props.style.height)
  t.is(copy.props.style.flexShrink, 1)
  t.ok(content, 'text and action may wrap onto separate lines')
  t.is(content.props.style.minWidth, 0)
  t.absent(row.props.style.height)
  t.is(tree.filter((node) => node.type === 'Pressable').length, 0)
  t.is(tree.filter((node) => node.type === 'Icon').length, 0)
  t.absent(row.props.accessibilityRole, 'a presentational note does not announce itself as an alert')
})

test('NoteBar forwards role and live-region props and hides the decorative icon', (t) => {
  const render = load()
  const row = render({ text: 'Sem internet', icon: 'semconexao', accessibilityRole: 'alert', accessibilityLiveRegion: 'polite', role: 'status', 'aria-live': 'assertive' })
  t.is(row.props.accessibilityRole, 'alert')
  t.is(row.props.accessibilityLiveRegion, 'polite')
  t.is(row.props.role, 'status')
  t.is(row.props['aria-live'], 'assertive')
  const tree = nodes(row)
  t.is(tree.find((node) => node.type === 'Icon').props.name, 'semconexao')
  const hidden = tree.find((node) => node.props.accessibilityElementsHidden)
  t.is(hidden.props.importantForAccessibility, 'no-hide-descendants')
  t.is(hidden.props['aria-hidden'], true)
  t.is(render({ text: 'Sem internet', accessibilityLiveRegion: 'polite' }).props['aria-live'], 'polite', 'native and web share the same announcement intent')
})

test('NoteBar delegates action and close only on press with 44 pt targets', (t) => {
  const render = load()
  const calls = []
  const onPress = () => calls.push('action')
  const onClose = () => calls.push('close')
  const row = render({ text: 'Nova versão disponível', action: { label: 'Atualizar', onPress }, onClose })
  t.alike(calls, [], 'rendering performs no action')
  const buttons = nodes(row).filter((node) => node.type === 'Pressable')
  t.is(buttons.length, 2)
  const [action, close] = buttons
  t.is(action.props.accessibilityRole, 'button')
  t.is(action.props.accessibilityLabel, 'Atualizar')
  t.alike({ ...action.props.accessibilityState }, { disabled: false, busy: false })
  t.is(action.props['aria-disabled'], false)
  t.is(action.props['aria-busy'], false)
  t.is(action.props.onPress, onPress)
  t.ok(styleOf(action).minHeight >= 44)
  t.is(styleOf(action).maxWidth, '100%', 'a long action label stays within the content')
  t.is(close.props.accessibilityRole, 'button')
  t.is(close.props.accessibilityLabel, 'Fechar')
  t.ok(styleOf(close).minWidth >= 44)
  t.ok(styleOf(close).minHeight >= 44)
  action.props.onPress()
  close.props.onPress()
  t.alike(calls, ['action', 'close'])
})

test('NoteBar pending action is busy and cannot resend while close remains available', (t) => {
  const render = load()
  const calls = []
  const action = { label: 'Atualizar', onPress: () => calls.push('action'), pending: true }
  const row = render({ text: 'Nova versão disponível', action, onClose: () => calls.push('close') })
  const [button, close] = nodes(row).filter((node) => node.type === 'Pressable')
  t.is(button.props.disabled, true)
  t.alike({ ...button.props.accessibilityState }, { disabled: true, busy: true })
  t.is(button.props['aria-disabled'], true)
  t.is(button.props['aria-busy'], true)
  t.absent(button.props.onPress)
  t.is(nodes(button).find((node) => node.type === 'Text').props.children, 'Atualizar…')
  t.is(button.props.accessibilityLabel, 'Atualizar…', 'a screen reader hears the same pending text')
  t.alike(calls, [])
  close.props.onPress()
  t.alike(calls, ['close'])
  render({ text: 'Nova versão disponível', action: { ...action, pending: false } })
  t.alike(calls, ['close'], 'clearing pending does not retry the action')
  t.absent(/\b(?:Platform|window|document|navigator|fetch|setTimeout|setInterval)\b/.test(source), 'no platform gates, browser calls or automatic work')
})

test('NoteBar keeps separate visible and spoken action labels while pending', (t) => {
  const render = load()
  const action = { label: 'Ativar', accessibilityLabel: 'Ativar avisos neste aparelho', pendingLabel: 'Ativar' }
  for (const pending of [false, true]) {
    const row = render({ text: 'Receber avisos neste aparelho', action: { ...action, pending } })
    const button = nodes(row).find((node) => node.type === 'Pressable')
    t.is(button.props.accessibilityLabel, 'Ativar avisos neste aparelho')
    t.is(nodes(button).find((node) => node.type === 'Text').props.children, 'Ativar')
    t.is(button.props.disabled, pending)
  }
})

test('NoteBar uses a supplied pending label for both display and speech by default', (t) => {
  const render = load()
  for (const pendingLabel of ['Ativando', '']) {
    for (const pending of [false, true]) {
      const row = render({ text: 'Receber avisos neste aparelho', action: { label: 'Ativar', pendingLabel, pending } })
      const button = nodes(row).find((node) => node.type === 'Pressable')
      t.is(button.props.accessibilityLabel, pending ? pendingLabel : 'Ativar')
      t.is(nodes(button).find((node) => node.type === 'Text').props.children, pending ? pendingLabel : 'Ativar')
    }
  }
})

test('NoteBar preserves a caller inset, close label and hit slop', (t) => {
  const render = load()
  const row = render({ text: 'Nova versão disponível.', action: { label: 'atualizar' }, onClose () {}, closeLabel: 'fechar', hitSlop: 12, style: { paddingTop: 30 } })
  t.is(styleOf(row).paddingTop, 30)
  t.is(styleOf(row).backgroundColor, 'warm')
  const [action, close] = nodes(row).filter((node) => node.type === 'Pressable')
  t.is(close.props.accessibilityLabel, 'fechar')
  for (const button of [action, close]) {
    t.is(button.props.hitSlop, 12)
    t.ok(styleOf(button).minHeight >= 44)
  }
})
