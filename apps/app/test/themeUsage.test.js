// Screens and ui files read colors from the active scheme (useTheme /
// useStyles), never from a static export that would pin them to light.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const SKIP = [
  path.join(APP, 'src/appearance.js'),
  path.join(APP, 'src/ui/theme.js'),
  path.join(APP, 'src/ui/ThemeProvider.js')
]

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

function scanned () {
  const files = [path.join(APP, 'App.js'), ...sources(path.join(APP, 'src'))]
  return files
    .filter((file) => !SKIP.includes(file) && !/encode.*\.web\.js$/.test(file))
    .map((file) => ({
      name: path.relative(APP, file),
      src: withoutComments(fs.readFileSync(file, 'utf8'))
    }))
}

// The text of the call that starts at the "(" of StyleSheet.create(.
function balancedBlock (src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

const FILES = scanned()

test('theme usage: files are scanned', (t) => {
  t.ok(FILES.length > 20, 'App.js, src, src/ui and src/gate are walked')
  t.ok(FILES.some((f) => f.name === 'src/gate/GateScreen.js'), 'gate is scanned')
  t.ok(FILES.some((f) => f.name === 'src/screens/Pessoas.js'), 'Pessoas is scanned')
})

// Any relative path that ends at the theme or the ui barrel, App.js's
// './src/ui/theme' included.
const importRe = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*['"]\.{1,2}\/(?:[\w.-]+\/)*(?:theme|ui|ui\/index)(?:\.js)?['"]/
// A parameter list of plain names with simple defaults, ending in a default
// that reads colors: `(color = colors.soft)`, `({ size = 24, color = colors.ink })`.
const defaultRe = /\(\s*\{?\s*(?:[\w$]+(?:\s*=\s*[^,(){};=]+)?\s*,\s*)*[\w$]+\s*=\s*colors\./

test('theme usage: the guards catch what they guard', (t) => {
  t.ok(importRe.test("import { colors } from './theme'"))
  t.ok(importRe.test("import { colors, layout } from './src/ui/theme'"))
  t.ok(importRe.test("import { Page, colors } from '../ui'"))
  t.absent(importRe.test("import { useTheme } from '../ui/ThemeProvider'"))
  t.ok(defaultRe.test('function Icon ({ name, size = 24, color = colors.ink }) {'))
  t.ok(defaultRe.test('const Help = (color = colors.soft) => null'))
  t.absent(defaultRe.test('const tint = color === undefined ? colors.ink : color'))
})

test('theme usage: nobody imports the static colors', (t) => {
  for (const { name, src } of FILES) {
    t.absent(importRe.test(src), name + ': no static colors import')
  }
})

test('theme usage: styles that use colors are built per scheme', (t) => {
  for (const { name, src } of FILES) {
    let from = 0
    for (;;) {
      const at = src.indexOf('StyleSheet.create(', from)
      if (at === -1) break
      from = at + 1
      const block = balancedBlock(src, at + 'StyleSheet.create'.length)
      if (!/\bcolors\./.test(block)) continue
      const start = src.lastIndexOf('\n', at) + 1
      const end = src.indexOf('\n', at)
      const line = src.slice(start, end === -1 ? src.length : end)
      t.ok(line.includes('(colors) =>'), name + ': StyleSheet.create with colors is a (colors) => factory')
    }
  }
})

test('theme usage: no parameter defaults read the static colors', (t) => {
  for (const { name, src } of FILES) {
    t.absent(defaultRe.test(src), name + ': no colors parameter default')
  }
})

test('theme usage: no light-only literals in shared chrome', (t) => {
  const ui = withoutComments(fs.readFileSync(path.join(APP, 'src/ui/index.js'), 'utf8'))
  t.absent(ui.includes('#efece5'), 'ui/index.js has no #efece5')
  const app = withoutComments(fs.readFileSync(path.join(APP, 'App.js'), 'utf8'))
  t.absent(app.includes('#ffffff'), 'App.js has no #ffffff')
})
