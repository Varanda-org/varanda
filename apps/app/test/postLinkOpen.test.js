'use strict'

// The post opening card is read as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../src/ui/PostLinkOpen.js'), 'utf8')

test('the post opening card says what waits and reuses the invite card actions', (t) => {
  t.ok(source.includes('Você abriu o link de uma publicação'))
  t.ok(source.includes('Para ver, entre na Varanda ou crie sua conta. Pode ser preciso um convite.'))
  t.ok(source.includes("import { ENTER_LABEL, HOW_LABEL, LATER_LABEL } from '../inviteCardCopy'"))
  t.ok(source.includes("accessibilityRole='header'"))
  t.absent(source.includes('\u2014'))
  t.absent(source.includes('Platform.OS'))
})
