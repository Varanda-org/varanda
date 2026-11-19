'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

function load (component) {
  const source = readFileSync(join(__dirname, '../src/ui', component + '.js'), 'utf8')
  const element = (type, props) => ({ type, props })
  const colors = { accent: 'accent', card: 'card', inputOff: 'inputOff', ink: 'ink', line: 'line', soft: 'soft' }
  let state
  const modules = {
    react: {
      useState (initial) {
        state ??= initial
        return [state, (next) => { state = typeof next === 'function' ? next(state) : next }]
      }
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
    './Icon': { Icon: 'Icon' },
    './theme': { radius: { bubble: 24, pill: 999 }, space: { sm: 8, md: 12, lg: 16 }, type: { rowName: {}, meta: {} } },
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
  return exports[component]
}

function styleOf (node) {
  const { style } = node.props
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style
  return Object.assign({}, ...[resolved].flat().filter(Boolean))
}

test('Badge renders a decorative 6 pt dot with a theme default and colour override', (t) => {
  const render = load('Badge')
  const dot = render({})
  t.is(dot.type, 'View')
  t.alike(styleOf(dot), { width: 6, height: 6, borderRadius: 3, backgroundColor: 'accent' })
  t.is(dot.props.accessibilityElementsHidden, true)
  t.is(dot.props.importantForAccessibility, 'no-hide-descendants')
  t.is(dot.props['aria-hidden'], true)
  t.is(dot.props.children, undefined)
  t.alike(styleOf(render({ color: 'custom' })), { ...styleOf(dot), backgroundColor: 'custom' })
})

test('ProgressBar renders empty, partial and full fills and leaves the role to the caller', (t) => {
  const render = load('ProgressBar')
  for (const [value, width] of [[0, '0%'], [0.375, '37.5%'], [1, '100%']]) {
    const track = render({ value })
    const fill = track.props.children
    t.is(track.type, 'View')
    t.is(fill.type, 'View')
    t.alike(styleOf(track), { borderRadius: 999, backgroundColor: 'inputOff', overflow: 'hidden', height: 8 })
    t.alike(styleOf(fill), { borderRadius: 999, backgroundColor: 'accent', height: '100%', width })
    t.is(track.props.accessibilityRole, undefined)
    t.is(track.props.role, undefined)
    t.is(fill.props.accessibilityRole, undefined)
    t.is(fill.props.role, undefined)
  }
  const custom = render({ value: 0.5, height: 12, trackColor: 'custom' })
  t.is(styleOf(custom).height, 12)
  t.is(styleOf(custom).backgroundColor, 'custom')
})

test('ProgressBar treats a missing or non-finite value as empty and clamps the rest to 0..1', (t) => {
  const render = load('ProgressBar')
  for (const value of [undefined, NaN, Infinity, -Infinity, -0.4]) {
    t.is(styleOf(render({ value }).props.children).width, '0%', 'empty for ' + value)
  }
  t.is(styleOf(render({ value: 1.5 }).props.children).width, '100%')
})

test('Accordion updates card, button semantics, cue, chevron and body together', (t) => {
  const render = load('Accordion')
  const children = { type: 'Text', props: { children: 'Conteúdo' } }
  const props = { title: 'Detalhes', cueOpen: 'Fechar', cueClosed: 'Ler', children }

  function check (expanded) {
    const card = render(props)
    const [header, body] = card.props.children
    const [title, cue, icon] = header.props.children
    t.alike(styleOf(card), expanded
      ? { borderRadius: 24, borderWidth: 1, borderColor: 'inputOff', backgroundColor: 'inputOff' }
      : { borderRadius: 24, borderWidth: 1, borderColor: 'line', backgroundColor: 'card' })
    t.is(header.type, 'Pressable')
    t.is(header.props.accessibilityRole, 'button')
    t.is(header.props.accessibilityLabel, props.title)
    t.alike({ ...header.props.accessibilityState }, { expanded })
    t.is(header.props['aria-expanded'], expanded)
    const style = styleOf(header)
    t.is(style.minHeight, 56)
    t.is(style.padding, 16)
    t.is(style.gap, 12)
    t.is(title.props.children, props.title)
    t.is(cue.props.children, expanded ? props.cueOpen : props.cueClosed)
    t.is(icon.type, 'Icon')
    t.is(icon.props.name, expanded ? 'chevron-up' : 'escolher')
    if (expanded) t.is(body.props.children, children)
    else t.is(body, null)
    return header
  }

  check(false).props.onPress()
  check(true).props.onPress()
  check(false)
})

test('Accordion can omit either cue', (t) => {
  const render = load('Accordion')
  const props = { title: 'Detalhes' }
  const [closed] = render(props).props.children
  t.is(closed.props.children[1], null)
  closed.props.onPress()
  const [open] = render(props).props.children
  t.is(open.props.children[1], null)
})

test('Accordion follows expanded and onToggle when the parent holds the state', (t) => {
  const render = load('Accordion')
  const toggles = []
  const props = { title: 'Detalhes', expanded: true, onToggle: (next) => toggles.push(next), children: 'Conteúdo' }
  const [header, body] = render(props).props.children
  t.is(header.props['aria-expanded'], true)
  t.is(body.props.children, 'Conteúdo')
  header.props.onPress()
  t.alike(toggles, [false])
  const [again] = render(props).props.children
  t.is(again.props['aria-expanded'], true, 'only the parent changes a controlled accordion')
})

test('Accordion keeps the same border width open and closed', (t) => {
  const render = load('Accordion')
  const props = { title: 'Detalhes' }
  const closed = styleOf(render(props))
  render(props).props.children[0].props.onPress()
  const open = styleOf(render(props))
  t.is(open.borderWidth, closed.borderWidth)
  t.is(closed.borderWidth, 1)
  t.is(closed.borderColor, 'line')
  t.is(open.borderColor, 'inputOff')
  t.is(open.backgroundColor, 'inputOff')
})
