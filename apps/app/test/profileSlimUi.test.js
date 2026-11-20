'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const read = (name) => readFileSync(join(__dirname, '../src/ui', name + '.js'), 'utf8')
const about = read('ProfileAbout')
const shortcuts = read('ProfileShortcuts')

test('ProfileShortcuts is one horizontal strip that never wraps', (t) => {
  t.ok(/<ScrollView horizontal /.test(shortcuts))
  t.ok(shortcuts.includes('showsHorizontalScrollIndicator={false}'))
  t.absent(/flexWrap/.test(shortcuts))
  t.ok(shortcuts.includes("accessibilityRole='link'"))
})

test('both files keep a 44 pt target and the right roles', (t) => {
  t.ok(shortcuts.includes('layout.hit'))
  t.ok(about.includes('layout.hit'))
  t.ok(about.includes("accessibilityRole='button'"))
  t.ok(about.includes("closeLabel='Fechar'"))
})

test('no platform branch and no em dash', (t) => {
  for (const source of [about, shortcuts]) {
    t.absent(source.includes('Platform.OS'))
    t.absent(source.includes('\u2014'))
  }
})
