'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const colors = Object.fromEntries(['accent', 'accentInk', 'card', 'controlOff', 'danger', 'ink', 'line', 'skeleton', 'soft'].map((key) => [key, key]))
const element = (type, props) => typeof type === 'function' ? type(props) : { type, props }
const modules = {
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: ({ children }) => children },
  'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
  './Icon': { Icon: 'Icon' },
  './ThemeProvider': { useStyles: (make) => make(colors), useTheme: () => ({ colors }) },
  './theme': {
    radius: { bubble: 24 },
    space: { xs: 4, md: 12, lg: 16 },
    type: { caption: { fontSize: 12 }, meta: { fontSize: 13 }, rowName: { fontSize: 16, fontWeight: '600', lineHeight: 24 } }
  }
}

function load (name) {
  const source = readFileSync(join(__dirname, '../src/ui', name + '.js'), 'utf8')
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

modules['./Divider'] = load('Divider')
modules['./Radio'] = load('Radio')
const { Divider } = modules['./Divider']
const { ListRow, ListGroup } = load('ListRow')

function nodes (node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object') return []
  return [node, ...nodes(node.props.children)]
}

function pressables (node) {
  return nodes(node).filter(({ type }) => type === 'Pressable')
}

function styleOf (node) {
  const { style } = node.props
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean))
}

test('ListRow renders a compact button and expands to fit a caption', (t) => {
  const [compact] = pressables(ListRow({ icon: 'engrenagem', label: 'Ajustes', expanded: false }))
  const [icon, copy, chevron] = compact.props.children
  t.is(compact.props.accessibilityRole, 'button')
  t.is(compact.props.accessibilityLabel, 'Ajustes')
  t.is(compact.props.accessibilityState.expanded, false)
  t.is(compact.props['aria-expanded'], false)
  t.is(compact.props.accessibilityState.checked, undefined)
  t.is(compact.props['aria-checked'], undefined)
  t.is(styleOf(compact).minHeight, 48)
  t.is(styleOf(compact).paddingHorizontal, 16)
  t.is(styleOf(compact).gap, 12)
  t.is(styleOf(icon).width, 40)
  t.is(styleOf(icon).height, 40)
  t.absent(styleOf(icon).backgroundColor)
  t.is(icon.props.children.props.name, 'engrenagem')
  t.is(chevron.props.name, 'seta')
  t.alike(styleOf(copy.props.children[0]), { ...modules['./theme'].type.rowName, color: colors.ink })

  const [tall] = pressables(ListRow({ label: 'Aparência', caption: 'Tema do aplicativo', trailingText: 'Escuro', expanded: true }))
  const [, tallCopy, end] = tall.props.children
  t.is(styleOf(tall).minHeight, 76)
  t.is(styleOf(tall).height, undefined)
  t.is(tallCopy.props.children[1].props.children, 'Tema do aplicativo')
  t.is(styleOf(tallCopy.props.children[1]).color, colors.soft)
  t.is(end.type, 'Text')
  t.is(end.props.children, 'Escuro')
  t.is(tall.props.accessibilityLabel, 'Aparência, Tema do aplicativo, Escuro')
  t.is(tall.props['aria-expanded'], true)
})

test('ListRow exposes checked state for choice roles and renders a decorative mark', (t) => {
  for (const role of ['radio', 'switch', 'checkbox']) {
    for (const checked of [false, true]) {
      const row = ListRow({ label: 'Avisos', role, checked, trailingText: 'Ativos' })
      const [button] = pressables(row)
      const mark = button.props.children[2]
      t.alike(nodes(row).map(({ props }) => props.accessibilityRole).filter(Boolean), [role])
      t.is(button.props.accessibilityState.checked, checked)
      t.is(button.props['aria-checked'], checked)
      t.is(mark.props['aria-hidden'], true)
      t.is(styleOf(mark).backgroundColor, checked ? colors.accent : colors.card)
    }
  }

  const [button] = pressables(ListRow({ label: 'Avisos', checked: true }))
  t.is(button.props.accessibilityState.checked, undefined)
  t.is(button.props['aria-checked'], undefined)
  t.is(button.props.children[2].props.name, 'seta', 'a button row draws no mark it cannot announce')

  const [unset] = pressables(ListRow({ label: 'Avisos', role: 'radio' }))
  t.is(unset.props.accessibilityState.checked, false)
  t.is(unset.props['aria-checked'], false)
  t.is(styleOf(unset.props.children[2]).backgroundColor, colors.card, 'an unset choice shows an empty mark, not a chevron')
})

test('ListRow blocks disabled and pending presses and activates a choice on Space once', (t) => {
  let presses = 0
  let prevented = 0
  const onPress = () => { presses++ }
  const [enabled] = pressables(ListRow({ label: 'Avisos', role: 'radio', onPress }))
  const space = { key: ' ', preventDefault () { prevented++ } }
  enabled.props.onKeyDown(space)
  enabled.props.onKeyDown({ ...space, repeat: true })
  t.is(presses, 1)
  t.is(prevented, 2)

  for (const pending of [false, true]) {
    const [off] = pressables(ListRow({ label: 'Avisos', role: 'radio', disabled: !pending, pending, onPress }))
    t.is(off.props.disabled, true)
    t.is(off.props['aria-disabled'], true)
    t.is(off.props['aria-busy'], pending)
    t.alike({ ...off.props.accessibilityState }, { checked: false, expanded: undefined, disabled: true, busy: pending })
    t.is(off.props.onPress, undefined)
    t.is(off.props.onKeyDown, undefined)
  }
})

test('ListRow renders a divider above later rows and keeps actions beside the row button', (t) => {
  const action = element('Pressable', { accessibilityRole: 'button', accessibilityLabel: 'Remover' })
  const row = ListRow({ label: 'Aparelho', accessibilityLabel: 'Abrir aparelho', action })
  const [divider, lineup] = row.props.children
  const [button, sibling] = [lineup.props.children].flat()
  t.is(styleOf(divider).height, 1)
  t.is(button.props.accessibilityLabel, 'Abrir aparelho')
  t.is(sibling, action)
  t.alike(pressables(row), [button, action])
  t.alike(nodes(button).map(({ props }) => props.accessibilityRole).filter(Boolean), ['button'])
  t.is(ListRow({ first: true, label: 'Ajustes' }).props.children[0], null)
})

test('ListGroup forwards accessibility props and appends custom style', (t) => {
  const child = ListRow({ first: true, label: 'Escuro', role: 'radio', checked: true })
  const group = ListGroup({ children: child, accessibilityRole: 'radiogroup', accessibilityLabel: 'Aparência', style: { borderRadius: 8 } })
  t.is(group.props.children, child)
  t.is(group.props.accessibilityRole, 'radiogroup')
  t.is(group.props.accessibilityLabel, 'Aparência')
  t.alike({ ...group.props.style[0] }, { borderRadius: 24, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, overflow: 'hidden' })
  t.is(styleOf(group).borderRadius, 8)
})

test('Divider renders a decorative rule, or two rules around a caption', (t) => {
  const plain = Divider({})
  const labeled = Divider({ label: 'Conta', inset: 16 })
  for (const divider of [plain, labeled]) {
    t.is(divider.props.accessibilityElementsHidden, true)
    t.is(divider.props.importantForAccessibility, 'no-hide-descendants')
    t.is(divider.props['aria-hidden'], true)
  }
  t.alike(styleOf(plain), { height: 1, backgroundColor: colors.line, marginHorizontal: 0 })
  t.is(plain.props.children, null)
  t.is(styleOf(labeled).gap, 12)
  t.is(styleOf(labeled).marginHorizontal, 16)
  const [left, caption, right] = labeled.props.children
  for (const rule of [left, right]) {
    t.alike(styleOf(rule), { height: 1, backgroundColor: colors.line, flex: 1 })
  }
  t.is(caption.type, 'Text')
  t.is(caption.props.children, 'Conta')
  t.is(styleOf(caption).color, colors.soft)
})
