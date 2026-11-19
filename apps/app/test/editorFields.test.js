'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const read = (file) => readFileSync(join(__dirname, '../src/ui', file), 'utf8')

test('event fields keep their spoken labels', (t) => {
  const src = read('EventEditor.js')
  t.absent(src.includes('<TextInput'), 'no raw TextInput')
  t.ok(src.includes("inputProps={{ accessibilityLabel: 'nome do evento'"), 'event name label')
  t.ok(src.includes("inputProps={{ accessibilityLabel: 'lugar do evento'"), 'event place label')
})

test('poll option fields keep their numbered spoken labels', (t) => {
  const src = read('PollEditor.js')
  t.absent(src.includes('<TextInput'), 'no raw TextInput')
  t.ok(src.includes("inputProps={{ accessibilityLabel: 'opção ' + (index + 1) + ' da enquete'"), 'numbered poll option label')
})
