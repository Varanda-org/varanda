'use strict'

// Avaliar rating stars: icons, not characters; chosen differs by shape.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const screen = read('screens/Avaliar.js')
const icons = read('ui/Icon.js')

test('stars are estrela icons at 36 inside 44 pt targets', (t) => {
  t.ok(screen.includes("<Icon name='estrela' size={36} filled={n <= stars}"), 'icon at 36, filled when chosen')
  t.absent(/[★☆]/.test(screen.replace(/^\/\/.*$/gm, '')), 'no star characters in code')
  t.ok(/star: \{ minWidth: 44, minHeight: 44/.test(screen), '44 pt target')
})

test('radio semantics, checked state and haptic stay', (t) => {
  t.ok(screen.includes("accessibilityRole='radio'"), 'role radio')
  t.ok(screen.includes('accessibilityState={{ checked: stars === n }}'), 'checked state')
  t.ok(screen.includes("tap('select')"), 'select haptic on change')
  t.ok(screen.includes('setStars(n)'), 'value is 1 to 5')
})

test('estrela has a solid variant so selection is not colour-only', (t) => {
  t.ok(/name === 'estrela' && filled\) \{\s*return <Ionicons name='star'/.test(icons), 'filled star is Ionicons solid')
  t.ok(icons.includes("estrela: 'star'"), 'outline stays Feather')
})
