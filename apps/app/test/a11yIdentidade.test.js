'use strict'

// Screen reader semantics of Identidade (#154), pinned on the sources like
// the other screen tests.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const read = (name) => readFileSync(join(__dirname, '../src', name), 'utf8')

test('Identidade: the certificate field is named by its visible label, not by its placeholder', (t) => {
  const src = read('screens/Identidade.js')
  t.ok(src.split('<Field label=').length - 1 >= 5, 'name and certificate fields all carry a label')
  t.absent(/<\/Label>\n\s*<Field value=\{certText\}/.test(src), 'no bare Label above the certificate Field')
  t.is(src.split('<Field label={plain ? PLAIN_CERT_LABEL').length - 1, 1, 'setup step')
  t.is(src.split('<Field label={PLAIN_CERT_LABEL}').length - 1, 1, 'plain screen')
  t.is(src.split("<Field label='certificado de membro (JSON emitido pela associação)'").length - 1, 1, 'technical card')
})

test('Identidade: the public key toggle announces whether the key is shown', (t) => {
  const src = read('screens/Identidade.js')
  t.ok(src.includes('secondary expanded={showKey} onPress={() => setShowKey((v) => !v)}'), 'expanded follows showKey')
  t.ok(read('ui/index.js').includes('aria-expanded={expanded}'), 'web reads it')
})

test('Announcer: a live region that stays mounted, takes no room and is spoken on iOS', (t) => {
  const src = read('ui/Announcer.js')
  t.ok(src.includes("accessibilityLiveRegion='polite' aria-live='polite'>{text}</Text>"), 'always rendered, even with no text')
  t.ok(src.includes("position: 'absolute'") && src.includes("color: 'transparent'"), 'out of the layout, not opacity 0')
  t.absent(/hidden: \{[^}]*opacity/.test(src), 'Android drops an invisible view')
  t.ok(src.includes("Platform.OS !== 'ios'") && src.includes('announceForAccessibility(text)'), 'iOS has no live region and is told')
})

test('Identidade: the link note, the saved certificate and the registration note are announced', (t) => {
  const src = read('screens/Identidade.js')
  t.is(src.split('<Announcer text={note} />').length - 1, 2, 'both the setup step and the card')
  t.ok(src.includes('<Announcer text={done || regNote} />'), 'certificate saved and registration note')
})
