'use strict'

// The parent post above a reply carries "Em resposta a". The wiring checks
// read Conversa.js from disk.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/parentLabel.js')

test('parentLabel names the parent author when there is a name', async (t) => {
  const { parentLabel } = await load()
  t.is(parentLabel({ name: 'Ana Souza' }), 'Em resposta a Ana Souza')
  t.is(parentLabel({ name: '', username: 'ana' }), 'Em resposta a ana', 'a verified @nome stands in, without the @')
})

test('parentLabel stands alone without a name, and cleans peer text', async (t) => {
  const { parentLabel } = await load()
  t.is(parentLabel({}), 'Em resposta a')
  t.is(parentLabel(undefined), 'Em resposta a')
  t.is(parentLabel({ name: '   ' }), 'Em resposta a')
  const dirty = parentLabel({ name: 'An\u202ea\u0007' })
  t.ok(dirty.startsWith('Em resposta a An') && !dirty.includes('\u202e') && !dirty.includes('\u0007'), 'direction overrides and control characters never reach the screen')
})

test('Conversa shows the label over the parent, outside its dimmed box, and moves the connector with it', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  t.ok(src.includes("import { parentLabel } from '../parentLabel'"))
  const at = src.indexOf('<Text style={styles.parentLabel}')
  const parentAt = src.indexOf('<View style={styles.parent} ')
  t.ok(at > 0 && parentAt > at, 'the label comes before the parent card')
  t.ok(src.slice(at - 200, at).includes('onLayout={(e) => setParentLabelHeight(e.nativeEvent.layout.height)}'), 'the label height is measured')
  t.ok(src.includes('{ top: 60 + parentLabelHeight, height: parentHeight - 48 }'), 'the connector keeps its 4 pt under the parent avatar')
  t.ok(/parentLabel: \{[^}]*type\.replyMark/.test(src))
  t.absent(/parent: \{[^}]*parentLabel/.test(src))
})
