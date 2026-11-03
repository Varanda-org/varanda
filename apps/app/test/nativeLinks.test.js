'use strict'

// App.js is the shell. Read it as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const source = () => fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')

test('native group and community links reach the shell through Linking', (t) => {
  const s = source()
  t.ok(s.includes('parseAppLink('))
  t.ok(s.includes("'grupo'"))
  t.ok(s.includes("'comunidade'"))
  t.ok(s.includes('setPendingLink'))
  t.absent(s.includes("hostedPage === true && Platform.OS === 'web'"))
})

test('a group or community link is never consent to join', (t) => {
  t.absent(source().includes('group.join'))
})

test('a pending group or community link belongs to the installation it arrived on', (t) => {
  const s = source()
  t.ok(s.includes("{ kind: 'grupo', key: CAPTURED_GROUP, origin: ageOrigin }"))
  t.ok(s.includes("{ kind: 'comunidade', key: CAPTURED_COMMUNITY, origin: ageOrigin }"))
  t.ok(s.includes('setPendingLink({ kind: link.kind, key: link.key, origin: ageOrigin })'))
  t.ok(s.includes('pendingLink.origin !== ageOrigin'))
})
