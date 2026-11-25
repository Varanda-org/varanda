'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const helperSrc = readFileSync(join(__dirname, '../src/quickRepliesVisible.js'), 'utf8')
// eslint-disable-next-line no-new-func
const quickRepliesVisible = new Function(helperSrc.replace(/^export /m, '') + '\nreturn quickRepliesVisible')()
const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')

test('quick replies hide while the keyboard is open', (t) => {
  t.is(quickRepliesVisible(true, false), true)
  t.is(quickRepliesVisible(true, true), false)
  t.is(quickRepliesVisible(false, false), false)
})

test('Mensagem gates the quick replies on the keyboard', (t) => {
  t.ok(screen.includes('quickRepliesVisible(true, keyboardOpen)'))
})
