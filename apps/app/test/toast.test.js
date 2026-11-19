'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const colors = { toastBg: 'toastBg', toastInk: 'toastInk', line: 'line' }
const counter = { fontSize: 13, fontWeight: '600', lineHeight: 16 }

function load () {
  const source = readFileSync(join(__dirname, '../src/ui/Toast.js'), 'utf8')
  const element = (type, props) => ({ type, props })
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
    './ThemeProvider': { useStyles: (make) => make(colors) },
    './theme': { layout: { hit: 44 }, radius: { bubble: 24 }, space: { sm: 8, md: 12, lg: 16 }, type: { counter } }
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
  return exports.Toast
}

const Toast = load()

test('Toast renders a label in an unpositioned face without an action', (t) => {
  const style = { alignSelf: 'center' }
  const toast = Toast({ text: 'Publicação salva', style })
  const [faceStyle, callerStyle] = toast.props.style
  const [label, action] = toast.props.children
  t.is(toast.type, 'View')
  t.is(toast.props.pointerEvents, 'box-none')
  t.alike({ ...faceStyle }, {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 24,
    minHeight: 36,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 12,
    backgroundColor: colors.toastBg,
    borderWidth: 1,
    borderColor: colors.line
  })
  t.is(callerStyle, style)
  t.is(label.type, 'View')
  t.is(label.props.pointerEvents, 'none')
  t.is(label.props.style.flexShrink, 1)
  t.is(label.props.children.type, 'Text')
  t.is(label.props.children.props.children, 'Publicação salva')
  t.is(label.props.children.props.accessibilityRole, 'alert')
  t.alike({ ...label.props.children.props.style }, { ...counter, color: colors.toastInk })
  t.is(action, null)
})

test('Toast renders one accessible 44 pt action without hit slop', (t) => {
  let presses = 0
  const toast = Toast({ text: 'Publicação salva', actionLabel: 'Desfazer', onAction () { presses++ } })
  const actions = toast.props.children.filter((node) => node.type === 'Pressable')
  t.is(actions.length, 1)
  const [action] = actions
  t.is(action.props.accessibilityRole, 'button')
  t.is(action.props.accessibilityLabel, 'Desfazer')
  t.is(action.props.children.type, 'Text')
  t.is(action.props.children.props.children, 'Desfazer')
  t.ok(action.props.style.minWidth >= 44)
  t.ok(action.props.style.minHeight >= 44)
  t.is(action.props.hitSlop, undefined)
  t.is(presses, 0)
  action.props.onPress()
  t.is(presses, 1)
})

test('Toast requires both the action label and callback', (t) => {
  const text = 'Publicação salva'
  t.is(Toast({ text, actionLabel: 'Desfazer' }).props.children[1], null)
  t.is(Toast({ text, onAction () {} }).props.children[1], null)
})
