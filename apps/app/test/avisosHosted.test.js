'use strict'

// Avisos.js is a screen. Read it as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

test('Avisos polls on node.visible and a hosted refusal is not web-only', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.absent(source.includes('document.addEventListener'))
  t.absent(source.includes('document.visibilityState'))
  t.absent(/unsupported\s*\?\s*'web-only'/.test(source))
  t.ok(source.includes('node.visible'))
  t.absent(source.includes('AppState'))
  t.absent(source.includes('../visibility'))
  t.absent(source.includes('\u2014'))
})
