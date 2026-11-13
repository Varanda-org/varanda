'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { transformSync } = require('@babel/core')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const source = read('ui/SearchField.js')
const code = transformSync(source.replace(/^import .+\n/gm, '').replace(/\bexport /g, ''), {
  configFile: false,
  babelrc: false,
  plugins: ['@babel/plugin-transform-react-jsx']
}).code

// Keep native hosts local so focus and press handlers run in Node.
async function ui (scheme = 'light') {
  const themeSource = read('ui/theme.js').replace("import { Platform } from 'react-native'", "const Platform = { OS: 'native', select: (options) => options.default }")
  const theme = await import('data:text/javascript,' + encodeURIComponent(themeSource))
  const { paletteFor } = await import('../src/appearance.js')
  const { SEARCH_CLEAR } = await import('../src/topics.js')
  const colors = paletteFor(scheme)
  let focused = false
  const deps = {
    ...theme,
    SEARCH_CLEAR,
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useState: () => [focused, (next) => { focused = next }],
    useStyles: (make) => make(colors),
    useTheme: () => ({ colors }),
    StyleSheet: { create: (styles) => styles },
    ...Object.fromEntries(['Pressable', 'TextInput', 'View', 'Icon'].map((name) => [name, name]))
  }
  // eslint-disable-next-line no-new-func
  const SearchField = new Function(...Object.keys(deps), code + '\nreturn SearchField')(...Object.values(deps))
  return { colors, theme, render: (props = {}) => SearchField({ value: '', onChangeText: () => {}, ...props }) }
}

const child = (tree, type) => tree.children.find((node) => node && node.type === type)
const pillStyle = (tree) => Object.assign({}, ...tree.props.style.filter(Boolean))

test('SearchField forwards the search input contract and optional right content', async (t) => {
  const { render } = await ui()
  const inputRef = { current: null }
  const onChangeText = () => {}
  const onSubmitEditing = () => {}
  const right = { type: 'Action', props: {} }
  const tree = render({
    label: 'Pesquisar contas',
    placeholder: 'Nome ou @nome',
    value: '@varanda',
    onChangeText,
    maxLength: 100,
    onSubmitEditing,
    inputRef,
    autoFocus: true,
    right
  })
  const input = child(tree, 'TextInput').props
  t.is(input.accessibilityLabel, 'Pesquisar contas')
  t.is(input.placeholder, 'Nome ou @nome')
  t.is(input.value, '@varanda')
  t.is(input.onChangeText, onChangeText)
  t.is(input.maxLength, 100)
  t.is(input.onSubmitEditing, onSubmitEditing)
  t.is(input.ref, inputRef)
  t.is(input.autoFocus, true)
  t.is(input.returnKeyType, 'search')
  t.is(input.autoCapitalize, 'none')
  t.is(input.autoCorrect, false)
  t.is(input.spellCheck, false)
  t.is(tree.children[tree.children.length - 1], right)
  const empty = render()
  t.is(child(empty, 'TextInput').props.autoFocus, false)
  t.absent(child(empty, 'Pressable'), 'an empty query has no clear button')
  t.is(empty.children[empty.children.length - 1], null, 'right content is optional')
})

test('SearchField clear has a 44 pt target and only requests an empty draft', async (t) => {
  const { render } = await ui()
  const changes = []
  let submits = 0
  const props = { value: 'busca', onChangeText: (text) => changes.push(text), onSubmitEditing: () => { submits++ } }
  const tree = render(props)
  const clear = child(tree, 'Pressable')
  t.is(clear.props.accessibilityRole, 'button')
  t.is(clear.props.accessibilityLabel, 'limpar')
  t.ok(clear.props.style.minWidth >= 44, 'clear target is at least 44 pt wide')
  t.ok(clear.props.style.minHeight >= 44, 'clear target is at least 44 pt tall')
  t.is(clear.props.style.marginVertical, -1.5, 'the clear target overlaps the border, so the field does not grow')
  t.is(child(render({ ...props, clearLabel: 'limpar busca' }), 'Pressable').props.accessibilityLabel, 'limpar busca', 'a screen can name what the X clears')
  t.is(child(clear, 'Icon').props.name, 'fechar')
  clear.props.onPress()
  t.alike(changes, [''])
  t.is(submits, 0, 'clearing does not submit')
  t.is(child(render(props), 'TextInput').props.value, 'busca', 'the caller controls the draft')
  t.absent(child(render({ ...props, value: '' }), 'Pressable'))
  t.ok(child(render({ ...props, value: ' ' }), 'Pressable'), 'whitespace can also be cleared')
})

test('SearchField uses the active palette and shows focus on the pill', async (t) => {
  for (const scheme of ['light', 'dark']) {
    const { render, colors, theme } = await ui(scheme)
    const tree = render()
    const input = child(tree, 'TextInput').props
    const icon = child(tree, 'Icon').props
    t.is(icon.name, 'lupa')
    t.is(icon.color, colors.soft)
    t.is(input.placeholderTextColor, colors.placeholder)
    t.is(input.style[0].color, colors.ink)
    t.absent(input.style[0].fontFamily, 'the input keeps the system font')
    t.is(pillStyle(tree).borderRadius, theme.radius.pill)
    t.ok(pillStyle(tree).minHeight >= 44)
    t.is(pillStyle(tree).backgroundColor, colors.inputOff)
    input.onFocus()
    t.is(pillStyle(render()).borderColor, colors.accent, scheme + ': focus uses the accent')
    t.is(pillStyle(render()).backgroundColor, colors.card)
    child(render(), 'TextInput').props.onBlur()
    t.is(pillStyle(render()).borderColor, 'transparent', scheme + ': blur removes focus')
    t.is(pillStyle(render()).backgroundColor, colors.inputOff)
  }
})

test('SearchField keeps the rounded input focus contract for theme guards', (t) => {
  t.ok(source.includes('style={[styles.input, webInputReset]}'))
  t.ok(/searchFocused: \{ borderColor: colors\.accent/.test(source))
  t.absent(source.includes('Platform.OS'))
  t.absent(source.includes('\u2014'))
})
